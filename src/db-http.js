// D1 ueber die Cloudflare-REST-API - fuer den Ingest ausserhalb von Cloudflare.
//
// Hintergrund: Workers Free erlaubt nur 10 ms CPU pro Cron-Ausfuehrung, das
// reicht fuer einen Snapshot ueber tausende Adressen nicht. Der Ingest laeuft
// darum in einer GitHub Action und schreibt von dort ueber HTTP nach D1. Der
// Worker selbst liest nur noch - das passt bequem ins Limit.
//
// Bildet dieselbe Teilmenge wie scripts/local-db.mjs nach, damit src/ingest.js
// unveraendert in beiden Umgebungen laeuft.
//
// Limits laut Cloudflare: eine Anfrage bis 100 KB, max. 100 Platzhalter pro
// Statement. Unsere Statements haben <= 13 Platzhalter; die Batchgroesse ist
// unten so gewaehlt, dass die 100 KB sicher eingehalten werden.

// Schreibzeilen pro Tag im D1-Gratis-Tarif. Dient nur der Prozentangabe im Log.
const TAGESLIMIT = 100000;

const API = "https://api.cloudflare.com/client/v4";
export const MAX_BATCH = 50;

class Stmt {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    // Wie bei D1: liefert ein NEUES Statement, veraendert dieses nicht.
    return new Stmt(this.db, this.sql, params.map(norm));
  }
  async run() {
    const [res] = await this.db._send([{ sql: this.sql, params: this.params }]);
    return { success: true, meta: res.meta ?? {} };
  }
  async first(col) {
    const [res] = await this.db._send([{ sql: this.sql, params: this.params }]);
    const row = res.results?.[0];
    if (!row) return null;
    return col ? row[col] : row;
  }
  async all() {
    const [res] = await this.db._send([{ sql: this.sql, params: this.params }]);
    return { success: true, results: res.results ?? [] };
  }
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return v.toString();
  return v;
}

export class D1Http {
  /**
   * @param {object} cfg { accountId, databaseId, token, onRequest? }
   */
  constructor({ accountId, databaseId, token, onRequest } = {}) {
    if (!accountId || !databaseId || !token) {
      throw new Error(
        "D1Http braucht accountId, databaseId und token " +
          "(Umgebungsvariablen CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_API_TOKEN)"
      );
    }
    this.url = `${API}/accounts/${accountId}/d1/database/${databaseId}/query`;
    this.token = token;
    this.onRequest = onRequest;
    this.requests = 0;
    // Verbrauchte Schreibzeilen. D1 laesst im Gratis-Tarif 100.000 pro Tag zu.
    // Wird das gerissen, schlaegt der GANZE Stapel fehl - D1-Batches sind
    // atomar -, und der Lauf hinterlaesst nichts. Genau das ist tagelang
    // unbemerkt passiert: die Datenbank blieb leer, und am naechsten Tag begann
    // derselbe teure Erstlauf von vorn. Jeder Job zaehlt jetzt mit und schreibt
    // die Zahl am Ende ins Log.
    this.rowsWritten = 0;
  }

  /** Eine Zeile fuers Job-Log: wie viel vom Tagesbudget dieser Lauf kostet. */
  schreibBericht() {
    const anteil = ((this.rowsWritten / TAGESLIMIT) * 100).toFixed(1);
    return (
      "D1-Schreiblast: " + this.rowsWritten.toLocaleString("de-DE") +
      " Zeilen = " + anteil + "% des Tagesbudgets (" +
      TAGESLIMIT.toLocaleString("de-DE") + ")"
    );
  }

  prepare(sql) {
    return new Stmt(this, sql);
  }

  /** D1-batch: Statements werden gebuendelt an die REST-API geschickt. */
  async batch(stmts) {
    const out = [];
    for (let i = 0; i < stmts.length; i += MAX_BATCH) {
      const slice = stmts.slice(i, i + MAX_BATCH);
      out.push(
        ...(await this._send(slice.map((s) => ({ sql: s.sql, params: s.params }))))
      );
    }
    return out;
  }

  async _send(batch, attempt = 0) {
    this.requests++;
    if (this.onRequest) this.onRequest(this.requests, batch.length);

    let res, body;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch.length === 1 ? batch[0] : { batch }),
      });
      body = await res.json();
    } catch (e) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(3, attempt)));
        return this._send(batch, attempt + 1);
      }
      throw new Error("D1-Anfrage fehlgeschlagen: " + e.message);
    }

    if (!res.ok || body.success === false) {
      const msg =
        body?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ??
        `HTTP ${res.status}`;
      // 429/5xx sind voruebergehend - erneut versuchen.
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * Math.pow(3, attempt)));
        return this._send(batch, attempt + 1);
      }
      throw new Error(
        "D1-Fehler: " + msg + "\n  erstes Statement: " + String(batch[0]?.sql).slice(0, 160)
      );
    }
    const ergebnis = body.result ?? [];
    for (const r of ergebnis) this.rowsWritten += r?.meta?.rows_written ?? 0;
    return ergebnis;
  }

  /** Mehrzeiliges SQL (z.B. schema.sql) anwenden. */
  // Erst im Batch versuchen (schnell), bei einem Fehler auf Einzel-Statements
  // zurueckfallen, damit eine einzelne fehlschlagende ALTER TABLE-Zeile
  // (Spalte existiert schon, siehe "Migrationen" am Ende von schema.sql) nicht
  // die ganze Charge mitreisst. CREATE TABLE IF NOT EXISTS aendert nichts an
  // einer bereits bestehenden Tabelle - neue Spalten brauchen diesen Weg.
  async exec(sql) {
    const stmts = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = 0; i < stmts.length; i += MAX_BATCH) {
      const chunk = stmts.slice(i, i + MAX_BATCH);
      try {
        await this._send(chunk.map((s) => ({ sql: s, params: [] })));
      } catch {
        for (const s of chunk) {
          try {
            await this._send([{ sql: s, params: [] }]);
          } catch (e) {
            if (/duplicate column name/i.test(e.message)) continue; // Migration bereits angewendet
            throw new Error("Schema-Fehler bei: " + s.slice(0, 100) + "\n  " + e.message);
          }
        }
      }
    }
    return stmts.length;
  }

  close() {}
}

/** Baut den Client aus Umgebungsvariablen. */
export function fromEnv(env = process.env) {
  return new D1Http({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.D1_DATABASE_ID,
    token: env.CLOUDFLARE_API_TOKEN,
  });
}
