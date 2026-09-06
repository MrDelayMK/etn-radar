// Grosse Migrations-Ereignisse: an welchen Tagen ist ungewoehnlich viel ETN
// aus der Bridge abgeflossen, und an welche Wallets?
//
// Zwei Schritte:
//   1. Ausreisser-Tage aus der bereits vorhandenen Tages-Historie der Bridge
//      finden (daily_balances) - kostet nichts, nur eine Berechnung.
//   2. Fuer die groessten Ausreisser die Empfaenger nachschlagen. Die Bridge
//      selbst hat KEINE normalen Top-Level-Transaktionen (gegengeprueft -
//      leere Liste), sie sendet ETN ausschliesslich ueber interne
//      Transaktionen (Nebeneffekt der Contract-Logik).
//
// WICHTIG (gegengeprueft, urspruengliche Annahme war falsch): die Bridge ist
// keineswegs duenn belegt - allein Ende Juli/August kamen ~2.000 echte
// Transfers zusammen (~250 Seiten fuer 4 Wochen). Darum EINMAL gemeinsam so
// weit wie noetig zurueckpaginieren (bis zum aeltesten zu analysierenden
// Ausreisser-Tag) und danach die Treffer nach Tag bucketen - statt wie
// zuvor pro Tag komplett neu ab Seite 1 zu paginieren (8x dieselben Seiten
// abrufen, und trotzdem nie tief genug fuer die aelteren Tage).
//
// Ausreisser-Definition: Tagesabfluss > 3x den Median der letzten 90 Tage.
// Bewusst der Median, nicht der Durchschnitt - ein einzelner Riesentag soll
// die Schwelle fuer sich selbst nicht anheben.

import { fetchInternalTransactions } from "./blockscout.js";

const AUSREISSER_FAKTOR = 3;
const MAX_TAGE = 8; // hoechstens so viele Ausreisser-Tage im Detail analysieren
// Sicherheitsdeckel fuer den EINEN gemeinsamen Durchlauf. 800 Seiten (40.000
// Eintraege) kosten bei ~1,5 Seiten/s rund 9 Minuten - unkritisch fuer einen
// monatlichen Lauf, reicht aber je nach Bridge-Aktivitaet evtl. nicht bis zum
// aeltesten Ausreisser zurueck. Wird das nicht erreicht, markiert
// runBridgeEventAnalysis den betroffenen Tag als "unvollstaendig" statt
// faelschlich 0 Empfaenger zu melden.
const MAX_SEITEN_GESAMT = 1100;

function median(werte) {
  const s = [...werte].sort((a, b) => a - b);
  const mitte = Math.floor(s.length / 2);
  return s.length % 2 ? s[mitte] : (s[mitte - 1] + s[mitte]) / 2;
}

/**
 * @param {object} env  { EXPLORER_API, BRIDGE_ADDRESS }
 * @param {object} db   D1-kompatible Datenbank
 */
export async function findeAusreisserTage(env, db) {
  const bridge = String(env.BRIDGE_ADDRESS).toLowerCase();
  const rows = (
    await db
      .prepare("SELECT day, etn FROM daily_balances WHERE address = ? ORDER BY day ASC")
      .bind(bridge)
      .all()
  ).results;

  const deltas = [];
  for (let i = 1; i < rows.length; i++) {
    const abfluss = rows[i - 1].etn - rows[i].etn;
    if (abfluss > 0) deltas.push({ day: rows[i].day, abfluss });
  }
  if (deltas.length < 5) return []; // zu wenig Historie fuer eine sinnvolle Schwelle

  const schwelle = median(deltas.map((d) => d.abfluss)) * AUSREISSER_FAKTOR;
  return deltas.filter((d) => d.abfluss > schwelle).sort((a, b) => b.abfluss - a.abfluss);
}

/**
 * Analysiert die groessten Ausreisser-Tage im Detail: welche Wallets haben
 * an diesem Tag ETN aus der Bridge erhalten?
 */
export async function runBridgeEventAnalysis(env, db, opts = {}) {
  const log = opts.log ?? (() => {});
  const api = env.EXPLORER_API;
  const bridge = String(env.BRIDGE_ADDRESS).toLowerCase();

  const ausreisser = await findeAusreisserTage(env, db);
  log(ausreisser.length + " Ausreisser-Tage gefunden (Schwelle: Median x " + AUSREISSER_FAKTOR + ")");
  const zuAnalysieren = ausreisser.slice(0, opts.limit ?? MAX_TAGE);

  const upsert = db.prepare(
    "INSERT INTO bridge_events (day, outflow_etn, recipient_count, top_recipients, unvollstaendig, analyzed_at)" +
      " VALUES (?,?,?,?,?,?)" +
      " ON CONFLICT(day) DO UPDATE SET outflow_etn=excluded.outflow_etn," +
      "   recipient_count=excluded.recipient_count, top_recipients=excluded.top_recipients," +
      "   unvollstaendig=excluded.unvollstaendig, analyzed_at=excluded.analyzed_at"
  );

  const jetzt = new Date().toISOString();
  let analysiert = 0;

  if (zuAnalysieren.length === 0) {
    await db
      .prepare(
        "INSERT INTO bridge_event_runs (taken_at, day, tage_gefunden, tage_analysiert, status)" +
          " VALUES (?,?,?,?,?)"
      )
      .bind(jetzt, jetzt.slice(0, 10), ausreisser.length, 0, "ok")
      .run();
    return { gefunden: 0, analysiert: 0 };
  }

  // Ein einziger gemeinsamer Durchlauf statt einem pro Tag: bis zum VORTAG
  // des AELTESTEN zu analysierenden Ausreissers zurueckpaginieren, damit
  // jeder Tag darin vollstaendig (00:00-23:59 UTC) enthalten ist.
  const aeltesterTag = zuAnalysieren.reduce((a, b) => (a.day < b.day ? a : b)).day;
  const bisZeit = new Date(Date.parse(aeltesterTag + "T00:00:00Z") - 86400000).toISOString();

  log("Ein gemeinsamer Durchlauf bis " + aeltesterTag + " zurueck (Deckel " + MAX_SEITEN_GESAMT + " Seiten) ...");
  const { transfers, seiten, gedeckelt } = await fetchInternalTransactions(api, bridge, {
    maxPages: MAX_SEITEN_GESAMT,
    bisZeit,
  });
  const tatsaechlichErreicht = transfers.length
    ? transfers[transfers.length - 1].timestamp.slice(0, 10)
    : jetzt.slice(0, 10);
  log(
    "  " + seiten + " Seiten, " + transfers.length + " Transfers, aeltester erreichter Tag: " + tatsaechlichErreicht
  );

  const proTag = new Map();
  for (const t of transfers) {
    const tag = t.timestamp.slice(0, 10);
    if (!proTag.has(tag)) proTag.set(tag, []);
    proTag.get(tag).push(t);
  }

  for (const tag of zuAnalysieren) {
    // Wurde tatsaechlich bis zu diesem Tag zurueckpaginiert? Wenn der Deckel
    // VOR dem Erreichen dieses Tages griff, waere "0 Empfaenger" eine
    // Falschaussage - dann lieber ehrlich als unvollstaendig markieren.
    const erreicht = !gedeckelt || tag.day >= tatsaechlichErreicht;
    if (!erreicht) {
      await upsert.bind(tag.day, tag.abfluss, null, null, 1, jetzt).run();
      log("  " + tag.day + ": Deckel erreicht, bevor dieser Tag erreicht wurde - als unvollstaendig markiert");
      continue;
    }

    const anDiesemTag = proTag.get(tag.day) ?? [];
    const proEmpfaenger = new Map();
    for (const t of anDiesemTag) {
      proEmpfaenger.set(t.to, (proEmpfaenger.get(t.to) ?? 0) + t.etn);
    }
    const topEmpfaenger = [...proEmpfaenger.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([address, etn]) => ({ address, etn }));

    await upsert
      .bind(tag.day, tag.abfluss, proEmpfaenger.size, JSON.stringify(topEmpfaenger), 0, jetzt)
      .run();
    analysiert++;
    log(
      "  " + tag.day + ": Abfluss " + Math.round(tag.abfluss).toLocaleString("de-DE") + " ETN - " +
        anDiesemTag.length + " Transfers, " + proEmpfaenger.size + " verschiedene Empfaenger gefunden"
    );
  }

  await db
    .prepare(
      "INSERT INTO bridge_event_runs (taken_at, day, tage_gefunden, tage_analysiert, status)" +
        " VALUES (?,?,?,?,?)"
    )
    .bind(jetzt, jetzt.slice(0, 10), ausreisser.length, analysiert, "ok")
    .run();

  return { gefunden: ausreisser.length, analysiert };
}
