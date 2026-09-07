// Tiefenzaehlung fuer die unteren Tiers (Crab bis Microbe).
//
// Laeuft NICHT alle 6h wie der normale Ingest, sondern woechentlich - siehe
// die Begruendung in src/tiers.js (Abschnitt "Zwei Geschwindigkeiten").
// Schreibt bewusst nur Summenzahlen pro Stufe, keine einzelnen Wallet-Zeilen.
//
// Dust (< CENSUS_DUST_FLOOR) wird hier nicht berechnet - das passiert beim
// Lesen in src/index.js aus snapshots.total_addresses minus allem
// nachweislich Darueberliegenden, weil total_addresses sich zwischen Snapshot
// und Census leicht verschieben kann und die Differenz erst zum Zeitpunkt der
// Anzeige stimmen muss.

import { fetchTopAddresses } from "./blockscout.js";
import { TIERS, CENSUS_DUST_FLOOR } from "./tiers.js";

const CENSUS_TIERS = TIERS.filter((t) => t.census && t.key !== "dust");

/**
 * @param {object} env  { EXPLORER_API }
 * @param {object} db   D1-kompatible Datenbank
 * @param {object} opts { depth, log, onProgress }
 */
export async function runCensus(env, db, opts = {}) {
  const log = opts.log ?? (() => {});
  const depth = opts.depth ?? Number(env.CENSUS_DEPTH ?? 250000);
  const t0 = Date.now();
  const takenAt = new Date().toISOString();
  const day = takenAt.slice(0, 10);

  log("Tiefenzaehlung: hole bis zu " + depth.toLocaleString("de-DE") + " Adressen ...");
  const { rows, pages } = await fetchTopAddresses(env.EXPLORER_API, depth, (n, p) => {
    if (opts.onProgress) opts.onProgress(n, p);
  });

  const letzte = rows[rows.length - 1];
  const erreichtDustGrenze = letzte && letzte.etn < CENSUS_DUST_FLOOR;
  if (!erreichtDustGrenze) {
    log(
      "  WARNUNG: Tiefe reichte nicht bis " + CENSUS_DUST_FLOOR.toLocaleString("de-DE") +
        " ETN (tiefste erreichte Balance: " + Math.round(letzte?.etn ?? 0).toLocaleString("de-DE") +
        "). CENSUS_DEPTH erhoehen."
    );
  }

  // Zaehlen. Jede Stufe hat eine feste Unter- und Obergrenze aus tiers.js -
  // die Bedingungen entstehen daraus, damit eine spaetere Schwellenaenderung
  // sich nicht mit dieser Zaehlung widerspricht.
  const zaehlungen = CENSUS_TIERS.map((t) => {
    const idx = TIERS.indexOf(t);
    const max = idx > 0 ? TIERS[idx - 1].min : Infinity;
    const treffer = rows.filter((r) => r.etn >= t.min && r.etn < max);
    return {
      tier: t.key,
      count: treffer.length,
      etn_sum: treffer.reduce((s, r) => s + r.etn, 0),
    };
  });

  log("  Ergebnis:");
  for (const z of zaehlungen) log("    " + z.tier.padEnd(10) + String(z.count).padStart(8) + " Wallets");

  // Nur Stufen schreiben, die der Lauf auch WIRKLICH ganz gesehen hat.
  //
  // Reichte die Tiefe nicht bis unter die Untergrenze einer Stufe, ist deren
  // Zahl kein Ergebnis, sondern ein Ausschnitt - meist eine glatte Null. Die
  // Leseseite nimmt je Stufe den zuletzt geschriebenen Tag; ein zu flacher
  // Lauf haette also die richtigen Zahlen der Vorwoche durch Nullen ersetzt.
  // Genau das kam beim Test mit geringer Tiefe heraus: shrimp, plankton und
  // microbe standen auf 0, obwohl es sie zu Hunderttausenden gibt.
  const tiefste = letzte?.etn ?? Infinity;
  const belastbar = zaehlungen.filter((z) => {
    const t = CENSUS_TIERS.find((x) => x.key === z.tier);
    return t && t.min > tiefste;
  });
  const uebersprungen = zaehlungen.filter((z) => !belastbar.includes(z));
  if (uebersprungen.length) {
    log(
      "  NICHT gespeichert (Tiefe reichte nicht bis unter ihre Grenze): " +
        uebersprungen.map((z) => z.tier).join(", ")
    );
  }

  const stmts = belastbar.map((z) =>
    db
      .prepare(
        "INSERT INTO tier_census (day, tier, count, etn_sum) VALUES (?,?,?,?)" +
          " ON CONFLICT(day, tier) DO UPDATE SET count=excluded.count, etn_sum=excluded.etn_sum"
      )
      .bind(day, z.tier, z.count, z.etn_sum)
  );
  if (stmts.length) await db.batch(stmts);

  const ms = Date.now() - t0;
  await db
    .prepare(
      "INSERT INTO census_runs (taken_at, day, depth_reached, lowest_balance, pages, duration_ms, status)" +
        " VALUES (?,?,?,?,?,?,?)"
    )
    .bind(takenAt, day, rows.length, letzte?.etn ?? null, pages, ms, erreichtDustGrenze ? "ok" : "partial")
    .run();

  log("Tiefenzaehlung fertig in " + (ms / 60000).toFixed(1) + " Minuten");
  return { depth_reached: rows.length, pages, duration_ms: ms, zaehlungen, vollstaendig: erreichtDustGrenze };
}
