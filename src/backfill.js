// Historie nachladen: fuer jede bekannte Adresse den Balance-Verlauf holen und
// die letzte echte Bewegung bestimmen.
//
// Zwei Endpoints, weil keiner allein reicht:
//
//   coin-balance-history-by-day  ~90 Tage, nur Tage MIT Aenderung.
//                                Liefert eine LEERE Liste, wenn sich im Fenster
//                                nichts getan hat - nicht etwa eine flache Linie.
//   coin-balance-history         Einzelaenderungen, zeitlich unbegrenzt.
//                                Nur damit ist das echte Datum der letzten
//                                Bewegung zu bekommen (teils >2,5 Jahre her).
//
// Ohne den zweiten Endpoint gelten ausgerechnet die laengsten Schlaefer als
// "heute bewegt" - die Schlaefer-Erkennung waere damit genau invertiert.

import { fetchDailyHistory, fetchBalanceChanges, drosselStatus } from "./blockscout.js";

// Wie viele Seiten der Aenderungshistorie hoechstens geholt werden (50 pro Seite).
const MAX_HISTORY_PAGES = 8;

/** Wei (als String) in ETN, ohne Praezisionsverlust bei sehr grossen Werten. */
const weiZuEtn = (wei) => Number(BigInt(wei) / 10n ** 12n) / 1e6;

/** Letzter Tag, an dem sich die Balance im Tagesverlauf geaendert hat. */
function lastMovementDay(hist) {
  for (let i = hist.length - 1; i > 0; i--) {
    if (hist[i].balance_wei !== hist[i - 1].balance_wei) return hist[i].day;
  }
  return hist[0]?.day ?? null;
}

/**
 * @param {object} env  { EXPLORER_API }
 * @param {object} db   D1-kompatible Datenbank
 * @param {object} opts { parallel, limit, log, onProgress }
 */
export async function runBackfill(env, db, opts = {}) {
  const log = opts.log ?? (() => {});
  // Die eigentliche Bremse sitzt in blockscout.js und gilt global. Diese Zahl
  // bestimmt nur, wie viele Anfragen gleichzeitig offen sind - nicht die Rate.
  const parallel = opts.parallel ?? 3;
  const api = env.EXPLORER_API;
  const heute = new Date().toISOString().slice(0, 10);

  // Nur Adressen ohne Backfill-Zeile -> jederzeit wiederaufsetzbar.
  const todo = (
    await db
      .prepare(
        "SELECT c.address, c.etn, c.balance_wei FROM current_balances c" +
          " WHERE NOT EXISTS (SELECT 1 FROM daily_balances d" +
          "                   WHERE d.address = c.address AND d.source = 'backfill')" +
          " ORDER BY c.etn DESC" +
          (opts.limit ? " LIMIT " + Number(opts.limit) : "")
      )
      .all()
  ).results;

  log(todo.length + " Adressen offen (parallel: " + parallel + ")");
  if (todo.length === 0) return { done: 0, days: 0, failed: 0, fallback: 0 };

  const insDaily = db.prepare(
    "INSERT INTO daily_balances (address, day, balance_wei, etn, source)" +
      " VALUES (?,?,?,?,'backfill')" +
      " ON CONFLICT(address, day) DO UPDATE SET" +
      // Ein vorhandener Snapshot-Wert ist genauer als der Tageswert des
      // Explorers und wird nicht ueberschrieben.
      "   balance_wei = CASE WHEN daily_balances.source = 'snapshot'" +
      "                 THEN daily_balances.balance_wei ELSE excluded.balance_wei END," +
      "   etn         = CASE WHEN daily_balances.source = 'snapshot'" +
      "                 THEN daily_balances.etn ELSE excluded.etn END"
  );
  const setMoved = db.prepare("UPDATE current_balances SET updated_at = ? WHERE address = ?");

  const state = { done: 0, days: 0, failed: 0, fallback: 0 };
  const t0 = Date.now();
  const queue = [...todo];

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;
      try {
        // Beide Endpoints abfragen. Der Aenderungs-Endpoint kostet einen
        // zusaetzlichen Aufruf, liefert dafuer aber zwei Dinge, die by-day
        // nicht kann: das echte Datum der letzten Bewegung (zeitlich
        // unbegrenzt) und Stuetzpunkte weit vor dem 90-Tage-Fenster. Erst
        // damit sind Zeitraeume wie 6 Monate ueberhaupt auswertbar.
        //
        // Guenstiger Zufall: gerade die Schlaefer, bei denen lange Historie am
        // meisten zaehlt, haben die wenigsten Aenderungen - eine Seite deckt
        // ihre gesamte Vergangenheit ab.
        const [hist, changes] = await Promise.all([
          fetchDailyHistory(api, row.address),
          // Bis ~13 Monate zurueck, hoechstens 8 Seiten. Ruhige Wallets sind
          // nach einer Seite fertig; nur die wenigen Dauer-Aktiven blaettern
          // tiefer - und genau die brauchen es fuer 6M/1Y.
          fetchBalanceChanges(api, row.address, { maxPages: MAX_HISTORY_PAGES, bisTage: 400 }),
        ]);

        // Reihenfolge ist Absicht: erst die groben Stuetzpunkte aus der
        // Aenderungsliste (aeltester zuerst, damit pro Tag der spaeteste Wert
        // gewinnt), danach die praeziseren Tageswerte, die sie ueberschreiben.
        const stmts = [];
        for (const c of [...changes].reverse()) {
          stmts.push(
            insDaily.bind(row.address, c.at.slice(0, 10), c.balance_wei, weiZuEtn(c.balance_wei))
          );
        }
        for (const h of hist) {
          stmts.push(insDaily.bind(row.address, h.day, h.balance_wei, h.etn));
        }
        state.days += hist.length + changes.length;
        if (changes.length) state.fallback++;

        // Ohne Eintraege entstuende keine Backfill-Zeile und die Adresse wuerde
        // bei jedem Lauf erneut abgefragt. Der heutige Stand dient als Anker.
        if (stmts.length === 0) {
          stmts.push(insDaily.bind(row.address, heute, row.balance_wei, row.etn));
        }

        // changes[0] ist die neueste Aenderung ueberhaupt und damit immer
        // genauer als der Tagesverlauf - deshalb hat sie Vorrang.
        let movedAt = null;
        if (changes.length) {
          movedAt = changes[0].at;
        } else {
          const day = lastMovementDay(hist);
          // 23:59:59Z, damit ein Snapshot desselben Tages spaeter einsortiert wird
          if (day) movedAt = day + "T23:59:59.000Z";
        }
        if (movedAt) stmts.push(setMoved.bind(movedAt, row.address));

        for (let i = 0; i < stmts.length; i += 50) {
          await db.batch(stmts.slice(i, i + 50));
        }
      } catch (e) {
        state.failed++;
        if (state.failed <= 5) log("  Fehler bei " + row.address + ": " + e.message);
      }
      state.done++;
      if (opts.onProgress && (state.done % 25 === 0 || state.done === todo.length)) {
        const rate = state.done / ((Date.now() - t0) / 1000);
        opts.onProgress(state.done, todo.length, Math.round((todo.length - state.done) / rate));
      }
    }
  }

  await Promise.all(Array.from({ length: parallel }, worker));
  log(
    "Fertig in " + ((Date.now() - t0) / 1000).toFixed(0) + "s: " + state.done +
      " Adressen, " + state.days + " Tageswerte, " + state.failed + " Fehler, " +
      state.fallback + " mit Langzeit-Historie" +
      (drosselStatus().gedrosselt ? ", " + drosselStatus().gedrosselt + "x vom Explorer gebremst" : "")
  );
  return state;
}
