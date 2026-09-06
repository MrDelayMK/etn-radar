// Grosse Migrations-Ereignisse: an welchen Tagen ist ein ungewoehnlich
// GROSSER Einzelbetrag aus der Bridge geflossen, und an wen?
//
// Grundlage sind die internen Transaktionen der Bridge. Sie sendet ETN
// naemlich nicht ueber normale Top-Level-Transaktionen - die Liste ist dort
// leer (gegengeprueft) -, sondern ausschliesslich ueber interne Transfers
// innerhalb der Contract-Logik.
//
// WARUM NICHT UEBER DIE TAGESBILANZ (frueherer Ansatz, war falsch):
// Zuerst wurden Ausreisser aus daily_balances bestimmt (Tagesrueckgang >
// 3x Median) und danach die Empfaenger gesucht. Das ergab widerspruechliche
// Zahlen: fuer den 06.08.2026 stand ein Rueckgang von 6.970.369 ETN, waehrend
// an dem Tag nur ein einziger Transfer ueber 3.000.000 ETN lief. Der Rest
// stammte vom Vortag - die Tagesgrenze von `coin-balance-history-by-day`
// stimmt nicht mit der Tagesgrenze der Zeitstempel ueberein. Kopfzahl und
// Empfaengerliste passten dadurch grundsaetzlich nicht zusammen.
//
// Jetzt wird ausschliesslich mit den Transfers selbst gerechnet. Damit ist
// die Summe per Definition die Summe der aufgefuehrten Transfers, das Datum
// kommt vom Zeitstempel, und Tage ohne grossen Einzelbetrag fallen von selbst
// heraus - was das Panel "Big migration events" auch verspricht.

import { fetchInternalTransactions } from "./blockscout.js";

// Ab welchem Einzelbetrag ein Transfer ueberhaupt interessant ist. Darunter
// ist es Alltagsverkehr: an einem beliebigen Tag laufen hunderte kleine
// Migrationen, die niemand einzeln sehen will.
const MIN_TRANSFER_ETN = 500000;

// Wie weit zurueck geschaut wird und wie viele Tage im Ergebnis landen.
const TAGE_ZURUECK = 90;
const MAX_TAGE = 12;

// Sicherheitsdeckel fuer den einen Durchlauf. Die Bridge ist aktiv (~250
// Seiten pro Monat gemessen); 1.100 Seiten decken rund zwei Monate ab und
// kosten bei ~1,5 Seiten/s etwa 12 Minuten.
const MAX_SEITEN = 1100;

/**
 * @param {object} env  { EXPLORER_API, BRIDGE_ADDRESS }
 * @param {object} db   D1-kompatible Datenbank
 */
export async function runBridgeEventAnalysis(env, db, opts = {}) {
  const log = opts.log ?? (() => {});
  const api = env.EXPLORER_API;
  const bridge = String(env.BRIDGE_ADDRESS).toLowerCase();
  const schwelle = opts.schwelle ?? MIN_TRANSFER_ETN;
  const abZeit = new Date(Date.now() - TAGE_ZURUECK * 86400000).toISOString();

  log("Hole interne Transfers der Bridge bis " + abZeit.slice(0, 10) + " zurueck ...");
  const { transfers, seiten, gedeckelt } = await fetchInternalTransactions(api, bridge, {
    maxPages: MAX_SEITEN,
    bisZeit: abZeit,
  });
  const aeltesterErreicht = transfers.length
    ? transfers[transfers.length - 1].timestamp.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  log("  " + seiten + " Seiten, " + transfers.length + " Transfers, zurueck bis " + aeltesterErreicht);

  // Nur die grossen Einzelbetraege - und nur die im Zeitfenster.
  const gross = transfers.filter((t) => t.etn >= schwelle && t.timestamp >= abZeit);
  log("  davon >= " + Math.round(schwelle).toLocaleString("de-DE") + " ETN: " + gross.length);

  // Nach Tag buendeln.
  const proTag = new Map();
  for (const t of gross) {
    const tag = t.timestamp.slice(0, 10);
    if (!proTag.has(tag)) proTag.set(tag, []);
    proTag.get(tag).push(t);
  }

  const tage = [...proTag.entries()]
    .map(([day, ts]) => ({
      day,
      summe: ts.reduce((s, t) => s + t.etn, 0),
      transfers: ts.sort((a, b) => b.etn - a.etn),
    }))
    .sort((a, b) => b.summe - a.summe)
    .slice(0, opts.limit ?? MAX_TAGE);

  const jetzt = new Date().toISOString();

  // Alte Eintraege verwerfen: sie stammen aus der Tagesbilanz-Rechnung und
  // sind mit den neuen Zahlen nicht vergleichbar.
  await db.prepare("DELETE FROM bridge_events").run();

  const upsert = db.prepare(
    "INSERT INTO bridge_events (day, outflow_etn, recipient_count, top_recipients, unvollstaendig, analyzed_at)" +
      " VALUES (?,?,?,?,?,?)" +
      " ON CONFLICT(day) DO UPDATE SET outflow_etn=excluded.outflow_etn," +
      "   recipient_count=excluded.recipient_count, top_recipients=excluded.top_recipients," +
      "   unvollstaendig=excluded.unvollstaendig, analyzed_at=excluded.analyzed_at"
  );

  for (const t of tage) {
    const empfaenger = t.transfers.slice(0, 10).map((x) => ({ address: x.to, etn: x.etn }));
    await upsert
      .bind(t.day, t.summe, t.transfers.length, JSON.stringify(empfaenger), 0, jetzt)
      .run();
    log(
      "  " + t.day + ": " + Math.round(t.summe).toLocaleString("de-DE") + " ETN in " +
        t.transfers.length + " grossen Transfer(s)"
    );
  }

  await db
    .prepare(
      "INSERT INTO bridge_event_runs (taken_at, day, tage_gefunden, tage_analysiert, zurueck_bis, status)" +
        " VALUES (?,?,?,?,?,?)"
    )
    .bind(jetzt, jetzt.slice(0, 10), proTag.size, tage.length, aeltesterErreicht,
          gedeckelt ? "partial" : "ok")
    .run();

  return {
    gefunden: proTag.size,
    analysiert: tage.length,
    grosse_transfers: gross.length,
    zurueck_bis: aeltesterErreicht,
    gedeckelt,
  };
}
