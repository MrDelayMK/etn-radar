// Tiefenzaehlung fuer die unteren Tiers (Crab bis Microbe).
//
// Laeuft NICHT alle 6h wie der normale Ingest, sondern woechentlich - siehe
// die Begruendung in src/tiers.js (Abschnitt "Zwei Geschwindigkeiten").
// Schreibt Summenzahlen pro Stufe und - seit 16.09.2026 - die einzelnen
// Wallets bis zur Plankton-Grenze fuer das Leaderboard (census_wallets).
//
// Dust (< CENSUS_DUST_FLOOR) wird hier nicht berechnet - das passiert beim
// Lesen in src/index.js aus snapshots.total_addresses minus allem
// nachweislich Darueberliegenden, weil total_addresses sich zwischen Snapshot
// und Census leicht verschieben kann und die Differenz erst zum Zeitpunkt der
// Anzeige stimmen muss.

import { fetchTopAddresses } from "./blockscout.js";
import { TIERS, CENSUS_DUST_FLOOR } from "./tiers.js";

const CENSUS_TIERS = TIERS.filter((t) => t.census && t.key !== "dust");
// Bis hierhin kommen einzelne Wallets ins Leaderboard: die Plankton-Grenze.
// Tiefer (Microbe) waeren es weitere ~37.000 Mini-Wallets bei jedem Lauf.
export const CENSUS_WALLET_MIN = TIERS.find((t) => t.key === "plankton").min;
// Grenzen, die das Leaderboard als Filter kennt: alle Stufen plus die
// Bestandsfilter (public/app.js, ETN_PRESETS). Andere Werte sucht es selbst.
export const LEADERBOARD_GRENZEN = [
  ...new Set([...TIERS.map((t) => t.min), 100_000, 500_000, 2_000_000, 10_000_000]),
].filter((g) => g > 0);

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

  // Die einzelnen Wallets unterhalb der Top N fuer das Leaderboard - nur,
  // wenn der Lauf wirklich bis unter die Untergrenze gekommen ist, sonst
  // fehlte der untere Teil und die Liste endete scheinbar zu frueh.
  let wallets = 0;
  if (tiefste < CENSUS_WALLET_MIN) {
    wallets = await walletsSpeichern(db, rows, takenAt, log);
  } else {
    log("  Wallets NICHT gespeichert: Tiefe reichte nicht bis " + CENSUS_WALLET_MIN.toLocaleString("de-DE") + " ETN");
  }

  const ms = Date.now() - t0;
  await db
    .prepare(
      "INSERT INTO census_runs (taken_at, day, depth_reached, lowest_balance, pages, duration_ms, status)" +
        " VALUES (?,?,?,?,?,?,?)"
    )
    .bind(takenAt, day, rows.length, letzte?.etn ?? null, pages, ms, erreichtDustGrenze ? "ok" : "partial")
    .run();

  log("Tiefenzaehlung fertig in " + (ms / 60000).toFixed(1) + " Minuten");
  return { depth_reached: rows.length, pages, duration_ms: ms, zaehlungen, wallets, vollstaendig: erreichtDustGrenze };
}

/*
 * Wallets unterhalb der Top N einzeln ablegen (census_wallets), damit das
 * Leaderboard nach Platz 3.000 weitergeht. Kostet keine Explorer-Anfrage -
 * die Zeilen hat der Census ohnehin geholt.
 *
 * Geschrieben wird nur, was sich geaendert hat: Bestand, Position oder die
 * Vorwochen-Zahl. Weil ein einziger Wechsel weiter oben alle Positionen
 * darunter verschiebt, sind das trotzdem oft fast alle Zeilen - rund 21.000,
 * einmal pro Woche, mit dem Index gut 40.000 von 100.000 am Tag. Deshalb nur
 * bis zur Plankton-Grenze und nicht bis Microbe.
 *
 * Unveraenderte Zeilen bleiben unberuehrt; wie aktuell sie sind, sagt der
 * Zeitpunkt des letzten Census (census_runs), nicht die Zeile selbst.
 */
async function walletsSpeichern(db, rows, takenAt, log) {
  const oben = new Set(
    (await db.prepare("SELECT address FROM current_balances WHERE in_top_n = 1").all()).results.map((r) => r.address)
  );
  const bisher = new Map(
    (await db.prepare("SELECT address, pos, balance_wei, etn, etn_vorher FROM census_wallets").all())
      .results.map((r) => [r.address, r])
  );

  const liste = rows.filter((r) => r.etn >= CENSUS_WALLET_MIN && !oben.has(r.hash));
  const ins = db.prepare(
    "INSERT INTO census_wallets (address, pos, rank_pos, balance_wei, etn, etn_vorher, tx_count, is_contract, name, gesehen)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?)" +
      " ON CONFLICT(address) DO UPDATE SET pos = excluded.pos, rank_pos = excluded.rank_pos," +
      "   balance_wei = excluded.balance_wei, etn = excluded.etn, etn_vorher = excluded.etn_vorher," +
      "   tx_count = excluded.tx_count, is_contract = excluded.is_contract, name = excluded.name," +
      "   gesehen = excluded.gesehen, aktualisiert = NULL"
  );

  const stmts = [];
  const dabei = new Set();
  liste.forEach((r, i) => {
    const pos = i + 1;
    dabei.add(r.hash);
    const alt = bisher.get(r.hash);
    // Vorwoche = Bestand beim letzten Census. War er gleich, ist die
    // Wochenveraenderung 0 - also etn_vorher = etn.
    const vorher = alt ? alt.etn : null;
    if (alt && alt.pos === pos && alt.balance_wei === r.balance_wei && alt.etn_vorher === vorher) return;
    stmts.push(
      ins.bind(
        r.hash, pos, r.rank_pos, r.balance_wei, r.etn, vorher, r.tx_count,
        r.is_contract ? 1 : 0, r.ens_name ?? r.contract_name ?? null, takenAt
      )
    );
  });
  // Wer diesmal nicht dabei war (gewachsen, geschrumpft, geleert), faellt raus.
  const weg = db.prepare("DELETE FROM census_wallets WHERE address = ?");
  for (const a of bisher.keys()) if (!dabei.has(a)) stmts.push(weg.bind(a));

  // Positionen der Bestandsgrenzen - Stufen und die Filter des Leaderboards.
  const grenze = db.prepare(
    "INSERT INTO census_grenzen (grenze, pos_unter, pos_bis) VALUES (?,?,?)" +
      " ON CONFLICT(grenze) DO UPDATE SET pos_unter = excluded.pos_unter, pos_bis = excluded.pos_bis"
  );
  const erste = (passt) => { const i = liste.findIndex(passt); return i < 0 ? liste.length + 1 : i + 1; };
  for (const g of LEADERBOARD_GRENZEN) {
    stmts.push(grenze.bind(g, erste((r) => r.etn < g), erste((r) => r.etn <= g)));
  }

  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));

  log("  Wallets fuer das Leaderboard: " + liste.length + " (" + stmts.length + " Zeilen geschrieben)");
  return liste.length;
}
