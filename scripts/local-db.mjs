// D1-kompatibler Adapter auf Basis von node:sqlite (in Node 24 eingebaut).
//
// Zweck: die Ingest-Logik lokal gegen eine echte SQLite-Datei testen, bevor
// irgendetwas zu Cloudflare hochgeht. Bildet genau die D1-Teilmenge nach, die
// src/ingest.js benutzt: prepare().bind().run()/.first()/.all() und batch().
//
// Wichtig: .bind() gibt - wie bei D1 - ein NEUES Statement-Objekt zurueck und
// veraendert das urspruengliche nicht. Sonst wuerde die Wiederverwendung
// vorbereiteter Statements in einer Schleife stillschweigend falsche Werte
// schreiben.

import { DatabaseSync } from "node:sqlite";

class Stmt {
  constructor(db, sql, args = null) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map(norm));
  }
  _prepared() {
    return this.db.prepare(this.sql);
  }
  async run() {
    const info = this._prepared().run(...(this.args ?? []));
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
  async first(col) {
    const row = this._prepared().get(...(this.args ?? []));
    if (row === undefined) return null;
    return col ? row[col] : row;
  }
  async all() {
    return { success: true, results: this._prepared().all(...(this.args ?? [])) };
  }
}

// SQLite akzeptiert kein boolean/undefined; D1 ist da nachsichtiger.
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export class LocalDB {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  /** D1-batch: alle Statements in einer Transaktion. */
  async batch(stmts) {
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }
  // Statement-fuer-Statement statt eines einzigen db.exec(sql): so kann eine
  // einzelne ALTER TABLE-Zeile fehlschlagen (Spalte existiert schon, siehe
  // "Migrationen" am Ende von schema.sql), ohne die restlichen Statements
  // mitzureissen. CREATE TABLE IF NOT EXISTS aendert nichts an einer bereits
  // bestehenden Tabelle - neue Spalten brauchen darum diesen Weg.
  exec(sql) {
    const stmts = sql
      .split("\n")
      .filter((z) => !z.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of stmts) {
      try {
        this.db.exec(s);
      } catch (e) {
        if (/duplicate column name/i.test(e.message)) continue; // Migration bereits angewendet
        throw new Error("Schema-Fehler bei: " + s.slice(0, 100) + "\n  " + e.message);
      }
    }
  }
  close() {
    this.db.close();
  }
}
