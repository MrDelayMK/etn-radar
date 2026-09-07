// Cloudflare Worker: liefert das Dashboard und die JSON-API.
//
// Der Worker LIEST nur. Das Einsammeln der Daten macht die GitHub Action
// (siehe .github/workflows/snapshot.yml), weil Workers Free nur 10 ms CPU pro
// Ausfuehrung erlaubt - fuer tausende Adressen zu wenig. Lesende Abfragen
// bleiben dagegen weit darunter, weil die Wartezeit auf D1 nicht als CPU zaehlt.

import { TIERS, tierProgress, tierFor, tierMax, FAST_TIER_MIN } from "./tiers.js";
import { clusterGruppen } from "./clusters.js";
import { handleTelegramWebhook } from "./telegram.js";

const CACHE_SEKUNDEN = 120; // Daten aendern sich nur alle 30 Minuten

const json = (data, status = 200, cache = CACHE_SEKUNDEN) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${cache}`,
      "access-control-allow-origin": "*",
    },
  });

const fehler = (msg, status = 400) => json({ error: msg }, status, 0);

/** Tag N Tage in der Vergangenheit als YYYY-MM-DD. */
const tagVor = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// Auswertbare Zeitraeume. 6m/1y funktionieren, weil der Backfill ueber
// coin-balance-history Stuetzpunkte bis zurueck zur Entstehung des Wallets
// holt - nicht nur die 90 Tage des by-day-Endpoints.
const ZEITRAUM = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "6m": 182, "1y": 365 };
const STD_ZEITRAUM = "7d";

// Anreicherung, die mehrere Endpoints teilen.
const WALLET_FELDER =
  "c.address, c.rank_pos, c.balance_wei, c.etn, c.tier, c.tx_count, c.updated_at, c.in_top_n," +
  " a.checksum_hash, a.label, a.label_type, a.label_source, a.ens_name, a.contract_name," +
  " a.impl_name, a.is_contract, a.exchange_score, a.is_excluded";

/** Ergaenzt Anzeigename, Tier-Fortschritt und Ruhedauer. */
function schmuecken(r, jetzt = Date.now()) {
  const p = tierProgress(r.etn);
  const ruhetage = r.updated_at
    ? Math.max(0, Math.floor((jetzt - Date.parse(r.updated_at)) / 86400000))
    : null;
  return {
    ...r,
    anzeige: r.label ?? r.ens_name ?? r.impl_name ?? r.contract_name ?? null,
    tier: p.tier.key,
    tier_name: p.tier.name,
    tier_emoji: p.tier.emoji,
    tier_progress: p.progress,
    bis_naechster_tier: p.isTop ? null : p.needed,
    naechster_tier: p.next?.name ?? null,
    ruhetage,
  };
}

async function overview(db, env) {
  const snap = await db
    .prepare(
      "SELECT id, taken_at, total_supply, bridge_wei, etn_price, addr_count, total_addresses" +
        " FROM snapshots WHERE status='ok' ORDER BY id DESC LIMIT 1"
    )
    .first();
  if (!snap) return { leer: true, hinweis: "Noch kein Snapshot vorhanden." };

  const heute = await db
    .prepare("SELECT * FROM network_daily ORDER BY day DESC LIMIT 1")
    .first();
  const reihe = (
    await db
      .prepare("SELECT * FROM network_daily WHERE day >= ? ORDER BY day ASC")
      .bind(tagVor(120))
      .all()
  ).results;

  const bridgeEtn = snap.bridge_wei ? Number(BigInt(snap.bridge_wei) / 10n ** 12n) / 1e6 : null;
  const supply = Number(snap.total_supply ?? 0);

  // Migrationstempo aus dem Bridge-Verlauf: wie schnell leert sie sich?
  //
  // Quelle ist daily_balances der Bridge-Adresse, nicht network_daily: die
  // Bridge-Historie kommt aus dem Backfill und reicht ~90 Tage zurueck,
  // waehrend network_daily erst ab dem ersten eigenen Snapshot waechst.
  // Dadurch steht die Hochrechnung ab dem ersten Tag zur Verfuegung.
  const bReihe = (
    await db
      .prepare(
        "SELECT day, etn, balance_wei FROM daily_balances" +
          " WHERE address = ? AND day >= ? ORDER BY day ASC"
      )
      .bind(String(env.BRIDGE_ADDRESS).toLowerCase(), tagVor(120))
      .all()
  ).results;

  let proTag = null;
  let restBeiDeadline = null;
  let tageBisDeadline = null;
  if (bReihe.length >= 2) {
    const a = bReihe[0];
    const b = bReihe[bReihe.length - 1];
    const tage = Math.max(1, (Date.parse(b.day) - Date.parse(a.day)) / 86400000);
    const diff = a.etn - b.etn;
    proTag = diff / tage;
    const dl = Date.parse(env.MIGRATION_DEADLINE + "T00:00:00Z");
    tageBisDeadline = Math.max(0, Math.round((dl - Date.now()) / 86400000));
    restBeiDeadline = Math.max(0, bridgeEtn - proTag * tageBisDeadline);
  }

  // Tier-Verteilung.
  //
  // Zwei Quellen, siehe die Begruendung in src/tiers.js ("Zwei Geschwindigkeiten"):
  //
  //   Humpback..Octopus  aus current_balances (jeder 30-Min-Snapshot, mit Verlauf)
  //   Crab..Microbe      aus tier_census (woechentliche Tiefenzaehlung, nur Summen)
  //   Dust               Rest aus total_addresses - allem nachweislich Darueberliegenden
  //
  // Gezaehlt wird ueber die BETRAEGE, nicht ueber current_balances.tier: die
  // Spalte ist nur ein beim Ingest geschriebener Cache. Aendert sich eine
  // Schwelle in tiers.js, waere sie sofort veraltet. Die Bedingungen hier
  // entstehen direkt aus TIERS und stimmen damit immer.
  const schnelleTiers = TIERS.filter((t) => !t.census);
  const faelle = schnelleTiers.map((t) => {
    const i = TIERS.indexOf(t);
    const max = i > 0 ? TIERS[i - 1].min : null;
    const b = "etn >= " + t.min + (max != null ? " AND etn < " + max : "");
    return (
      "SUM(CASE WHEN " + b + " THEN 1 ELSE 0 END) AS n_" + t.key +
      ", SUM(CASE WHEN " + b + " THEN etn ELSE 0 END) AS e_" + t.key
    );
  }).join(", ");

  const proTier =
    (await db
      .prepare(
        "SELECT " + faelle + " FROM current_balances WHERE in_top_n=1 AND address != ?"
      )
      .bind(String(env.BRIDGE_ADDRESS).toLowerCase())
      .first()) ?? {};

  const grenze = await db
    .prepare("SELECT MIN(etn) m, COUNT(*) n FROM current_balances WHERE in_top_n=1")
    .first();
  const tiefsteErfasst = grenze?.m ?? null;
  const erfasst = grenze?.n ?? 0;

  // Der 30-Min-Snapshot muss nur bis zur Octopus-Grenze reichen (FAST_TIER_MIN) -
  // alles darunter ist bewusst Aufgabe der Tiefenzaehlung, nicht ein Zeichen
  // dafuer, dass der Snapshot zu flach waere.
  const vollstaendig = tiefsteErfasst != null && tiefsteErfasst <= FAST_TIER_MIN;

  // Tiefenzaehlung: pro Stufe die JEWEILS neueste Zeile, auch wenn einzelne
  // Stufen an unterschiedlichen Tagen zuletzt aktualisiert wurden (z.B. nach
  // einem teilweise fehlgeschlagenen Lauf).
  const census = (
    await db
      .prepare(
        "SELECT tier, count, etn_sum, day FROM tier_census" +
          " WHERE (tier, day) IN (SELECT tier, MAX(day) FROM tier_census GROUP BY tier)"
      )
      .all()
  ).results;
  const proCensus = Object.fromEntries(census.map((c) => [c.tier, c]));
  const censusTag = census[0]?.day ?? null; // fuer die Anzeige "Stand vom ..."

  // Dust = alle Adressen der Chain minus die, die NACHWEISLICH darueber liegen
  // (schnelle Tiers + Census-Tiers). Genau dieselbe Rest-Rechnung, die zuvor
  // schon Plankton genutzt hat, jetzt eine Stufe tiefer angesetzt.
  const ueberDust =
    schnelleTiers.filter((t) => t.min > 0).reduce((s, t) => s + (proTier["n_" + t.key] ?? 0), 0) +
    Object.values(proCensus).reduce((s, c) => s + (c.count ?? 0), 0);
  const dustRest =
    vollstaendig && census.length && snap.total_addresses
      ? Math.max(0, snap.total_addresses - ueberDust)
      : null;

  const schlaefer = await db
    .prepare(
      "SELECT COUNT(*) anzahl, SUM(etn) etn FROM current_balances" +
        " WHERE etn >= 1000000 AND updated_at <= ? AND address != ?"
    )
    .bind(new Date(Date.now() - 90 * 86400000).toISOString(), String(env.BRIDGE_ADDRESS).toLowerCase())
    .all();

  return {
    snapshot: snap,
    preis: snap.etn_price,
    telegram_bot: env.TELEGRAM_BOT_USERNAME ?? null,
    total_supply: supply,
    bridge_etn: bridgeEtn,
    bridge_anteil: supply ? bridgeEtn / supply : null,
    zirkulierend: supply - (bridgeEtn ?? 0),
    migration: {
      deadline: env.MIGRATION_DEADLINE,
      tage_bis_deadline: tageBisDeadline,
      abfluss_pro_tag: proTag,
      rest_bei_deadline: restBeiDeadline,
      anteil_bei_deadline: supply && restBeiDeadline != null ? restBeiDeadline / supply : null,
    },
    holder: {
      ueber_1m: heute?.holders_1m ?? null,
      ueber_5m: heute?.holders_5m ?? null,
      ueber_10m: heute?.holders_10m ?? null,
      top10_anteil: heute?.top10_share ?? null,
      top100_anteil: heute?.top100_share ?? null,
      top1000_anteil: heute?.top1000_share ?? null,
    },
    schlaefer: schlaefer.results?.[0] ?? null,
    tier_info: {
      erfasst,
      tiefste_erfasste_balance: tiefsteErfasst,
      total_addresses: snap.total_addresses ?? null,
      vollstaendig,
      // Ab wo die 6h-Zaehlung ausduennt, falls der Snapshot zu flach ist
      unvollstaendig_ab: vollstaendig ? null : tierFor(tiefsteErfasst ?? 0).key,
      // Stand der woechentlichen Tiefenzaehlung (Crab bis Microbe)
      census_stand: censusTag,
      census_vorhanden: census.length > 0,
    },
    tiers: TIERS.map((t) => {
      if (t.key === "dust") {
        return { ...t, max: tierMax(t.key), anzahl: dustRest, etn: null, geschaetzt: true };
      }
      if (t.census) {
        const c = proCensus[t.key];
        return {
          ...t,
          max: tierMax(t.key),
          anzahl: c?.count ?? null,
          etn: c?.etn_sum ?? null,
          geschaetzt: false,
          census_stand: c?.day ?? null,
        };
      }
      return {
        ...t,
        max: tierMax(t.key),
        anzahl: proTier["n_" + t.key] ?? 0,
        etn: proTier["e_" + t.key] ?? 0,
        geschaetzt: false,
      };
    }),
    verlauf: reihe,
    bridge_verlauf: bReihe,
  };
}

async function leaderboard(db, env, u) {
  const limit = Math.min(250, Math.max(10, Number(u.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(u.searchParams.get("offset") ?? 0));
  const tage = ZEITRAUM[u.searchParams.get("period") ?? STD_ZEITRAUM] ?? 7;
  const tier = u.searchParams.get("tier");
  // "Nur echte Wallets": Bridge, Boersen UND Contracts raus. Uebrig bleibt,
  // was tatsaechlich einer Person oder Gruppe gehoert.
  const nurEcht = u.searchParams.get("nur_wallets") === "1";
  // Balance-Bereich, z.B. "zeig mir nur 100k-500k ETN".
  const minEtn = u.searchParams.get("min_etn") ? Number(u.searchParams.get("min_etn")) : null;
  const maxEtn = u.searchParams.get("max_etn") ? Number(u.searchParams.get("max_etn")) : null;

  const filter =
    " WHERE c.in_top_n = 1 AND c.address != ?" +
    (tier ? " AND c.tier = ?" : "") +
    (minEtn != null ? " AND c.etn >= ?" : "") +
    (maxEtn != null ? " AND c.etn <= ?" : "") +
    (nurEcht
      ? " AND COALESCE(a.is_excluded,0) = 0" +
        " AND COALESCE(a.label_type,'') NOT IN ('exchange','bridge','service')" +
        " AND COALESCE(a.is_contract,0) = 0"
      : "");

  const filterArgs = [String(env.BRIDGE_ADDRESS).toLowerCase()];
  if (tier) filterArgs.push(tier);
  if (minEtn != null) filterArgs.push(minEtn);
  if (maxEtn != null) filterArgs.push(maxEtn);

  // Rangberechnung ueber die GEFILTERTE Menge: wer Boersen ausblendet, will
  // auch, dass das erste echte Wallet auf Platz 1 steht - nicht auf Platz 3
  // mit zwei Luecken davor.
  //
  // platz_vorher nutzt als Rueckfall die heutige Balance. Ein Wallet ohne
  // bekannte Historie erscheint dadurch als unveraendert statt zufaellig ganz
  // oben oder unten; delta_sicher zeigt an, wie belastbar das ist.
  const sql =
    "WITH stand AS (" +
    "  SELECT " + WALLET_FELDER +
    "  , (SELECT d.etn FROM daily_balances d WHERE d.address = c.address AND d.day <= ?" +
    "     ORDER BY d.day DESC LIMIT 1) AS etn_vorher" +
    "  , (SELECT d.etn FROM daily_balances d WHERE d.address = c.address" +
    "     ORDER BY d.day ASC LIMIT 1) AS etn_erster" +
    "  , (SELECT d.day FROM daily_balances d WHERE d.address = c.address" +
    "     ORDER BY d.day ASC LIMIT 1) AS tag_erster" +
    "  FROM current_balances c LEFT JOIN addresses a ON a.hash = c.address" +
    filter +
    "), gereiht AS (" +
    "  SELECT *, ROW_NUMBER() OVER (ORDER BY etn DESC) AS platz," +
    "         ROW_NUMBER() OVER (ORDER BY COALESCE(etn_vorher, etn) DESC) AS platz_vorher" +
    "  FROM stand" +
    ") SELECT * FROM gereiht WHERE platz > ? AND platz <= ? ORDER BY platz";

  const [res, gesamt] = await Promise.all([
    db.prepare(sql).bind(tagVor(tage), ...filterArgs, offset, offset + limit).all(),
    db
      .prepare(
        "SELECT COUNT(*) n FROM current_balances c" +
          " LEFT JOIN addresses a ON a.hash = c.address" + filter
      )
      .bind(...filterArgs)
      .first(),
  ]);

  const jetzt = Date.now();
  return {
    zeitraum: u.searchParams.get("period") ?? STD_ZEITRAUM,
    offset,
    limit,
    gesamt: gesamt?.n ?? 0,
    eintraege: res.results.map((r) => ({
      ...schmuecken(r, jetzt),
      platz: r.platz,
      // Positiv = aufgestiegen (kleinere Platzzahl)
      rang_delta: r.platz_vorher != null ? r.platz_vorher - r.platz : null,
      ...delta(r, tage, jetzt),
    })),
  };
}

/**
 * Veraenderung ueber den Zeitraum.
 *
 * Fehlt eine Verlaufszeile, ist das nicht automatisch "unbekannt": wenn das
 * Wallet nachweislich laenger still liegt als der Zeitraum, ist die
 * Veraenderung exakt 0. Ohne diese Unterscheidung stuende in der Tabelle
 * ueberall "-", obwohl die Antwort feststeht.
 */
function delta(r, tage, jetzt = Date.now()) {
  const bilde = (vorher, sicher, ab) => ({
    delta_etn: r.etn - vorher,
    delta_pct: vorher ? ((r.etn - vorher) / vorher) * 100 : null,
    delta_sicher: sicher,
    delta_ab: ab ?? null,
  });

  // 1. Es gibt einen Stuetzpunkt am oder vor dem Stichtag - exakt.
  if (r.etn_vorher != null) return bilde(r.etn_vorher, true);

  // 2. Kein Stuetzpunkt, aber das Wallet liegt nachweislich laenger still als
  //    der Zeitraum -> die Veraenderung ist exakt null, nicht unbekannt.
  const ruhe = r.updated_at ? (jetzt - Date.parse(r.updated_at)) / 86400000 : null;
  if (ruhe != null && ruhe >= tage) {
    return { delta_etn: 0, delta_pct: 0, delta_sicher: true, delta_ab: null };
  }

  // 3. Notnagel fuer sehr aktive Wallets (Boersen): deren Aenderungshistorie
  //    ist so dicht, dass selbst mehrere hundert Eintraege nur Tage abdecken.
  //    Statt "unbekannt" wird ab dem aeltesten bekannten Punkt gerechnet und
  //    das Datum mitgeliefert, damit die Oberflaeche es kennzeichnen kann.
  if (r.etn_erster != null && r.tag_erster) {
    return bilde(r.etn_erster, false, r.tag_erster);
  }

  return { delta_etn: null, delta_pct: null, delta_sicher: false, delta_ab: null };
}

async function movers(db, env, u) {
  // Eigener Zeitstempel statt nur ueber /api/overview: die Activity-Seite
  // kann geladen werden, bevor Overview je geladen wurde, und soll trotzdem
  // zeigen koennen, wie alt die zugrundeliegenden Daten sind.
  const snap = await db
    .prepare("SELECT taken_at FROM snapshots WHERE status='ok' ORDER BY id DESC LIMIT 1")
    .first();
  const tage = ZEITRAUM[u.searchParams.get("period") ?? STD_ZEITRAUM] ?? 7;
  const limit = Math.min(50, Number(u.searchParams.get("limit") ?? 10));
  const sql =
    "SELECT * FROM (SELECT " + WALLET_FELDER +
    ", (SELECT d.etn FROM daily_balances d WHERE d.address = c.address AND d.day <= ?" +
    "   ORDER BY d.day DESC LIMIT 1) AS etn_vorher" +
    " FROM current_balances c LEFT JOIN addresses a ON a.hash = c.address" +
    " WHERE c.in_top_n = 1 AND c.address != ?)" +
    " WHERE etn_vorher IS NOT NULL";
  const args = [tagVor(tage), String(env.BRIDGE_ADDRESS).toLowerCase()];

  // Richtung explizit filtern. Ohne das fuellt die Sortierung die Gewinnerliste
  // mit Verlierern auf, sobald es weniger echte Gewinner als Plaetze gibt.
  const [gewinner, verlierer] = await Promise.all([
    db.prepare(sql + " AND etn > etn_vorher ORDER BY (etn - etn_vorher) DESC LIMIT ?")
      .bind(...args, limit).all(),
    db.prepare(sql + " AND etn < etn_vorher ORDER BY (etn - etn_vorher) ASC LIMIT ?")
      .bind(...args, limit).all(),
  ]);
  const jetzt = Date.now();
  const auf = (r) => ({
    ...schmuecken(r, jetzt),
    delta_etn: r.etn - r.etn_vorher,
    delta_pct: r.etn_vorher ? ((r.etn - r.etn_vorher) / r.etn_vorher) * 100 : null,
  });
  return {
    zeitraum: u.searchParams.get("period") ?? STD_ZEITRAUM,
    snapshot_taken_at: snap?.taken_at ?? null,
    gewinner: gewinner.results.map(auf),
    verlierer: verlierer.results.map(auf),
  };
}

async function sleepers(db, env, u) {
  const minEtn = Number(u.searchParams.get("min_etn") ?? 1000000);
  const minTage = Number(u.searchParams.get("min_tage") ?? 90);
  const limit = Math.min(200, Number(u.searchParams.get("limit") ?? 50));
  const grenze = new Date(Date.now() - minTage * 86400000).toISOString();

  const rows = (
    await db
      .prepare(
        "SELECT " + WALLET_FELDER +
          " FROM current_balances c LEFT JOIN addresses a ON a.hash = c.address" +
          " WHERE c.etn >= ? AND c.updated_at <= ? AND c.address != ?" +
          " ORDER BY c.updated_at ASC LIMIT ?"
      )
      .bind(minEtn, grenze, String(env.BRIDGE_ADDRESS).toLowerCase(), limit)
      .all()
  ).results;
  const jetzt = Date.now();
  return { min_etn: minEtn, min_tage: minTage, eintraege: rows.map((r) => schmuecken(r, jetzt)) };
}

// Mindestbewegung, damit ein Ereignis angezeigt wird - dieselbe Zahl wie
// MIN_EREIGNIS_ETN in src/ingest.js. Dort verhindert sie, dass neue
// Kleinstmeldungen ueberhaupt entstehen; hier blendet sie die bereits
// gespeicherten aus. Ohne das blieben die alten fuer immer stehen: der
// kleinste gemeldete "Sleeper woke up" bewegte 0 ETN.
//
// Ausgenommen sind die beiden Rang-Ereignisse und "drained": sie beschreiben
// keine Bewegungsgroesse. rank_exit fuehrt gar keinen Betrag mit, und
// "drained" ist ueber den Anteil definiert (95 Prozent des Wallets), nicht
// ueber den Betrag.
const MIN_EREIGNIS_ETN = 100000;
const OHNE_BETRAGSGRENZE = ["rank_exit", "drained"];

// Nicht im Meldungsstrom: "Left top N" ist Buchhaltung, keine Nachricht. Ein
// Wallet faellt aus den verfolgten Top 3.000, weil ANDERE gewachsen sind -
// es selbst muss sich dafuer nicht bewegt haben. Bei jedem Snapshot trifft
// das gut ein Dutzend Adressen, und die Liste bestand daraufhin aus nichts
// anderem mehr. Auf der Wallet-Detailseite bleibt der Eintrag: dort ist
// "diese Adresse ist aus den Top 3.000 gefallen" eine Auskunft ueber genau
// diese eine Adresse und damit am Platz.
const NICHT_IM_STROM = ["rank_exit"];

// Reihenfolge, in der ein gebuendeltes Ereignis benannt wird: die
// aussagekraeftigste Bezeichnung fuehrt, "Inflow"/"Outflow" ist der Rueckfall.
//
// Hintergrund: EINE Bewegung erzeugt bis zu drei Zeilen. Ein Wallet, das nach
// Monaten Stille 5,6 Millionen ETN bekommt und dabei eine Stufe aufsteigt,
// stand dreimal untereinander in der Liste - als Inflow, als Sleeper woke up
// und als Tier up, mit identischem Betrag und identischer Uhrzeit. Es ist
// aber ein Vorgang, nicht drei.
const TYP_RANG = ["drained", "sleeper_wake", "rank_enter", "tier_up", "tier_down", "gain", "loss"];

/** Zeilen derselben Adresse aus demselben Snapshot zu einem Eintrag machen. */
function buendeln(rows) {
  const nach = new Map();
  for (const r of rows) {
    const schluessel = r.address + "|" + r.detected_at;
    const da = nach.get(schluessel);
    if (!da) {
      nach.set(schluessel, { ...r, auch: [] });
      continue;
    }
    // Tier-Angaben mitnehmen, egal welche Zeile sie traegt.
    if (r.tier_from && !da.tier_from) {
      da.tier_from = r.tier_from;
      da.tier_to = r.tier_to;
    }
    da.severity = Math.max(da.severity ?? 0, r.severity ?? 0);
    const fuehrend = TYP_RANG.indexOf(r.type) < TYP_RANG.indexOf(da.type);
    if (fuehrend) {
      da.auch.push(da.type);
      da.type = r.type;
    } else {
      da.auch.push(r.type);
    }
  }
  return [...nach.values()];
}

/**
 * Merkliste: mehrere Wallets in EINER Abfrage.
 *
 * Die Liste selbst liegt im Browser des Besuchers (localStorage) - hier wird
 * nichts gespeichert, es gibt kein Konto und keine geschriebene Zeile. Der
 * Endpoint bekommt nur die Adressen mitgeschickt und liefert dieselben Felder
 * wie das Leaderboard zurueck.
 *
 * Adressen, die nicht in den verfolgten Top N liegen, stehen in "fehlend":
 * sie einfach wegzulassen waere die schlechtere Antwort - der Besucher hat sie
 * ja bewusst gemerkt und wuerde sie wortlos verlieren.
 */
async function watchlist(db, env, u) {
  const adressen = [
    ...new Set(
      (u.searchParams.get("addrs") ?? "")
        .toLowerCase()
        .split(",")
        .map((a) => a.trim())
        .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
    ),
  ].slice(0, 60);
  if (!adressen.length) return { eintraege: [], fehlend: [] };

  const tage = ZEITRAUM[u.searchParams.get("period") ?? STD_ZEITRAUM] ?? 7;
  const platzhalter = adressen.map(() => "?").join(",");
  const rows = (
    await db
      .prepare(
        "SELECT " + WALLET_FELDER +
          ", (SELECT d.etn FROM daily_balances d WHERE d.address = c.address AND d.day <= ?" +
          "   ORDER BY d.day DESC LIMIT 1) AS etn_vorher" +
          " FROM current_balances c LEFT JOIN addresses a ON a.hash = c.address" +
          " WHERE c.address IN (" + platzhalter + ")" +
          " ORDER BY c.etn DESC"
      )
      .bind(tagVor(tage), ...adressen)
      .all()
  ).results;

  const jetzt = Date.now();
  const gefunden = new Set(rows.map((r) => r.address));
  return {
    zeitraum: u.searchParams.get("period") ?? STD_ZEITRAUM,
    eintraege: rows.map((r) => ({
      ...schmuecken(r, jetzt),
      delta_etn: r.etn_vorher != null ? r.etn - r.etn_vorher : null,
      delta_pct:
        r.etn_vorher != null && r.etn_vorher > 0
          ? ((r.etn - r.etn_vorher) / r.etn_vorher) * 100
          : null,
    })),
    fehlend: adressen.filter((a) => !gefunden.has(a)),
  };
}

/* ---------- Kursverlauf ------------------------------------------------
 *
 * Quelle ist CoinGecko. Der Block-Explorer kam dafuer nicht in Frage: seine
 * Reihe ist auf 30 Tage festgenagelt (mit ?days= und ?resolution= gegen-
 * geprueft, beides wirkungslos), und ihr Kursfeld ist nur fuer den jeweils
 * neuesten Tag gefuellt - der Verlauf musste aus Marktkapitalisierung geteilt
 * durch Umlaufmenge zurueckgerechnet werden. Das war eine Naeherung, wo es
 * den echten Kurs frei zu haben gibt.
 *
 * CoinGecko liefert ohne Schluessel bis zu einem Jahr und waehlt die
 * Aufloesung selbst: 5 Minuten bei einem Tag, stuendlich bis 90 Tage, taeglich
 * darueber. "max" verlangt einen Bezahlplan - deshalb endet die Auswahl bei
 * einem Jahr.
 *
 * Faellt CoinGecko aus (das Gratis-Kontingent ist knapp, und Worker teilen
 * sich Adressen), wird auf die eigenen Snapshots zurueckgefallen. Die reichen
 * nur so weit zurueck wie dieses Dashboard laeuft, sind aber besser als eine
 * leere Karte.
 */
const KURS_ZEITRAUM = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

// Wie viele Punkte hoechstens zurueckgegeben werden. CoinGecko liefert fuer
// 30 Tage ueber 700 Stundenwerte; auf einer 700 Pixel breiten Kurve ist jeder
// zweite davon unsichtbar und kostet nur Uebertragung.
const KURS_MAX_PUNKTE = 320;

function ausduennen(punkte, max = KURS_MAX_PUNKTE) {
  if (punkte.length <= max) return punkte;
  const schritt = punkte.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(punkte[Math.floor(i * schritt)]);
  // Der letzte Punkt ist der aktuelle Kurs - der darf nie wegfallen.
  if (out[out.length - 1] !== punkte[punkte.length - 1]) out.push(punkte[punkte.length - 1]);
  return out;
}

async function preisverlauf(env, u) {
  const p = u.searchParams.get("period") ?? "30d";
  const tage = KURS_ZEITRAUM[p] ?? 30;

  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/coins/electroneum/market_chart" +
        "?vs_currency=usd&days=" + tage,
      { headers: { accept: "application/json" } }
    );
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const preise = d?.prices ?? [];
    if (!preise.length) throw new Error("leere Reihe");
    return {
      zeitraum: p,
      quelle: "coingecko",
      feinkoernig: tage <= 7,
      punkte: ausduennen(
        preise.map(([ms, preis]) => ({ zeit: new Date(ms).toISOString(), preis }))
      ),
    };
  } catch (e) {
    return { ...(await preisNotnagel(env, tage)), zeitraum: p, grund: e.message };
  }
}

/** Rueckfall auf die eigenen Snapshots, wenn CoinGecko nicht antwortet. */
async function preisNotnagel(env, tage) {
  const ab = new Date(Date.now() - tage * 86400000).toISOString();
  const rows = (
    await env.DB.prepare(
      "SELECT taken_at, etn_price FROM snapshots" +
        " WHERE etn_price IS NOT NULL AND taken_at >= ? ORDER BY taken_at ASC"
    )
      .bind(ab)
      .all()
  ).results;
  return {
    quelle: "snapshots",
    feinkoernig: tage <= 7,
    punkte: ausduennen(rows.map((r) => ({ zeit: r.taken_at, preis: r.etn_price }))),
  };
}

async function events(db, u) {
  const limit = Math.min(200, Number(u.searchParams.get("limit") ?? 50));
  const typ = u.searchParams.get("type");
  const minSev = Number(u.searchParams.get("min_severity") ?? 0);
  let sql =
    "SELECT e.*, a.label, a.ens_name, a.checksum_hash, c.etn, c.tier" +
    " FROM events e LEFT JOIN addresses a ON a.hash = e.address" +
    " LEFT JOIN current_balances c ON c.address = e.address" +
    " WHERE e.severity >= ?" +
    " AND e.type NOT IN (" + NICHT_IM_STROM.map(() => "?").join(",") + ")" +
    " AND (e.type IN (" + OHNE_BETRAGSGRENZE.map(() => "?").join(",") + ")" +
    "      OR abs(coalesce(e.delta_etn, 0)) >= ?)";
  const args = [minSev, ...NICHT_IM_STROM, ...OHNE_BETRAGSGRENZE, MIN_EREIGNIS_ETN];
  if (typ) {
    sql += " AND e.type = ?";
    args.push(typ);
  }
  sql += " ORDER BY e.detected_at DESC, e.severity DESC LIMIT ?";
  args.push(limit * 4);
  const rows = (await db.prepare(sql).bind(...args).all()).results;
  return {
    eintraege: buendeln(rows)
      .slice(0, limit)
      .map((r) => ({
        ...r,
        anzeige: r.label ?? r.ens_name ?? null,
        tier_emoji: r.etn != null ? tierFor(r.etn).emoji : null,
      })),
  };
}

async function wallet(db, env, hash) {
  const adr = hash.toLowerCase();
  const r = await db
    .prepare(
      "SELECT " + WALLET_FELDER + ", a.notes, a.first_seen, a.last_seen" +
        " FROM current_balances c LEFT JOIN addresses a ON a.hash = c.address" +
        " WHERE c.address = ?"
    )
    .bind(adr)
    .first();
  if (!r) return null;

  const verlauf = (
    await db
      .prepare(
        "SELECT day, etn, balance_wei FROM daily_balances WHERE address = ? ORDER BY day ASC"
      )
      .bind(adr)
      .all()
  ).results;
  const ereignisse = (
    await db
      .prepare(
        "SELECT * FROM events WHERE address = ?" +
          " AND (type IN (" + OHNE_BETRAGSGRENZE.map(() => "?").join(",") + ")" +
          "      OR abs(coalesce(delta_etn, 0)) >= ?)" +
          " ORDER BY detected_at DESC LIMIT 50"
      )
      .bind(adr, ...OHNE_BETRAGSGRENZE, MIN_EREIGNIS_ETN)
      .all()
  ).results;
  const ereignisseGebuendelt = buendeln(ereignisse);

  // Cluster-Bezug, fuer die Wallet-Detailseite: gehoert diese Adresse selbst
  // zu einer Cluster-Vermutung (hat eine erkannte Finanzierungsquelle), UND
  // finanziert sie umgekehrt selbst andere Wallets (dann ist sie die Quelle
  // in deren wallet_funding-Zeile)? Beides rein lesend aus bereits
  // vorhandenen Daten, keine zusaetzliche Explorer-Anfrage.
  const finanziertVon = await db
    .prepare(
      "SELECT wf.funding_source, wf.funding_share, wf.computed_at," +
        " a.label AS quelle_label, a.label_type AS quelle_typ" +
        " FROM wallet_funding wf LEFT JOIN addresses a ON a.hash = wf.funding_source" +
        " WHERE wf.address = ?"
    )
    .bind(adr)
    .first();
  const finanziertSelbst = (
    await db
      .prepare(
        "SELECT wf.address, wf.funding_share, c.etn, c.rank_pos" +
          " FROM wallet_funding wf JOIN current_balances c ON c.address = wf.address" +
          " WHERE wf.funding_source = ? ORDER BY c.etn DESC LIMIT 25"
      )
      .bind(adr)
      .all()
  ).results;

  return {
    ...schmuecken(r),
    verlauf,
    ereignisse: ereignisseGebuendelt,
    cluster: {
      finanziert_von: finanziertVon ?? null,
      finanziert_selbst: finanziertSelbst,
    },
  };
}

// ---------------------------------------------------------------------------
// Manuelle Trigger fuer lange Hintergrund-Jobs ("Run now"-Knoepfe)
//
// Der Worker kann weder die Tiefenzaehlung noch die Cluster-Analyse selbst
// ausfuehren (10 ms CPU-Limit, beide Laeufe dauern 15-30 Minuten). Ein Knopf
// loest stattdessen den passenden GitHub-Actions-Workflow per API aus. Eine
// 24h-Sperre PRO JOB verhindert, dass Klicks den Explorer wiederholt mit
// einem vollen Lauf belasten - sie wird erst NACH einem erfolgreichen
// Ausloesen gesetzt, damit ein Konfigurationsfehler (fehlendes Secret o.ae.)
// nicht gleich einen ganzen Tag blockiert.
// ---------------------------------------------------------------------------
const TRIGGER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const JOBS = {
  census: { workflow: "census.yml", runsTable: "census_runs" },
  clusters: { workflow: "clusters.yml", runsTable: "cluster_runs" },
  exchanges: { workflow: "exchange-detect.yml", runsTable: "exchange_detect_runs" },
  bridge: { workflow: "bridge-events.yml", runsTable: "bridge_event_runs" },
};

/**
 * Duerfen von hier aus Jobs ausgeloest werden?
 *
 * Die Trigger starten GitHub-Actions-Laeufe auf FREMDE Kosten (Actions-Minuten
 * des Repo-Besitzers) und belegen die 24h-Sperre. Solange das Dashboard privat
 * lief, war das egal. Oeffentlich erreichbar waere es das nicht mehr: jeder
 * mit der URL koennte Laeufe starten oder dem Besitzer die Sperre wegnehmen.
 *
 * Ist ADMIN_TOKEN gesetzt, braucht jeder Trigger den passenden Header. Ist es
 * NICHT gesetzt, bleibt alles wie bisher offen - so aendert sich fuer eine
 * rein private Instanz nichts.
 */
function adminOk(request, env) {
  if (!env.ADMIN_TOKEN) return true;
  return request.headers.get("X-Admin-Token") === env.ADMIN_TOKEN;
}

async function job_status(db, name) {
  const job = JOBS[name];
  const row = await db.prepare("SELECT last_triggered_at FROM job_control WHERE name=?").bind(name).first();
  const letzterLauf = await db
    .prepare(`SELECT taken_at, status FROM ${job.runsTable} ORDER BY id DESC LIMIT 1`)
    .first();
  const letzterTrigger = row?.last_triggered_at ?? null;
  const rest = letzterTrigger
    ? TRIGGER_COOLDOWN_MS - (Date.now() - Date.parse(letzterTrigger))
    : 0;
  return {
    letzter_trigger: letzterTrigger,
    letzter_lauf: letzterLauf ?? null,
    bereit: rest <= 0,
    wartezeit_ms: Math.max(0, rest),
  };
}

async function job_trigger(db, env, name) {
  const job = JOBS[name];
  const status = await job_status(db, name);
  if (!status.bereit) return { ok: false, grund: "cooldown", ...status };

  if (!env.GITHUB_PAT || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    return {
      ok: false,
      grund: "nicht_konfiguriert",
      hinweis:
        "GITHUB_PAT/GITHUB_OWNER/GITHUB_REPO sind nicht gesetzt. " +
        "Bis dahin: Actions-Tab -> Run workflow (" + job.workflow + ").",
    };
  }

  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/workflows/${job.workflow}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.GITHUB_PAT,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "etn-radar-worker",
    },
    body: JSON.stringify({ ref: env.GITHUB_BRANCH ?? "main" }),
  });

  if (res.status !== 204) {
    const text = await res.text().catch(() => "");
    return { ok: false, grund: "github_fehler", status: res.status, details: text.slice(0, 300) };
  }

  // Sperre erst nach Erfolg setzen - siehe Begruendung oben.
  const jetzt = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO job_control (name, last_triggered_at) VALUES (?, ?)" +
        " ON CONFLICT(name) DO UPDATE SET last_triggered_at = excluded.last_triggered_at"
    )
    .bind(name, jetzt)
    .run();

  return { ok: true, gestartet_um: jetzt };
}

/**
 * Cluster-Vermutungen: Wallets mit gemeinsamer Finanzierungsquelle.
 *
 * WICHTIG: kein Beweis, keine Identitaet - nur ein Muster (siehe die
 * ausfuehrliche Erklaerung in src/clusters.js und der README). Der Endpunkt
 * gibt deshalb immer einen Hinweistext mit, den die Oberflaeche sichtbar
 * neben jedem Ergebnis zeigen soll.
 */
async function clusters_api(db) {
  const gruppen = await clusterGruppen(db);
  const stand = await db
    .prepare("SELECT MAX(computed_at) t FROM wallet_funding")
    .first();
  return {
    hinweis:
      "Vermutung, kein Beweis: Wallets teilen sich hier nur eine erkennbare " +
      "Finanzierungsquelle. Das kann dieselbe Person sein, muss aber nicht " +
      "(z.B. Team-Auszahlungen an mehrere echte Mitarbeiter aus einer Quelle).",
    stand: stand?.t ?? null,
    gruppen,
  };
}

/**
 * Grosse Migrations-Tage: an welchen Tagen ist ungewoehnlich viel ETN aus der
 * Bridge geflossen, und an welche Wallets? Siehe src/bridge-events.js.
 */
// Ein Tag zaehlt nur, wenn an ihm mindestens EIN Transfer diese Groesse
// hatte. Dieselbe Zahl steht in src/bridge-events.js; hier wird sie beim Lesen
// noch einmal durchgesetzt.
//
// Warum doppelt: in der Datenbank koennen Zeilen aus einer aelteren Fassung
// des Laufs stehen, die noch aus der Tagesbilanz gerechnet hat. Solche Zeilen
// zeigen Tage mit siebenhundert Ueberweisungen zu je 50.000 ETN - also genau
// das, was dieses Panel nicht zeigen soll. Sie verschwinden damit sofort,
// statt erst beim naechsten woechentlichen Lauf.
const BRIDGE_MIN_TRANSFER_ETN = 500000;

/**
 * Haelt ein gespeicherter Tag der eigenen Zusage stand?
 *
 * Zwei Pruefungen, beide direkt aus dem, was das Panel verspricht:
 *
 *   1. Mindestens ein Einzeltransfer erreicht die Schwelle. Ein Tag aus
 *      siebenhundert Ueberweisungen zu je 50.000 ETN ist Alltagsverkehr.
 *   2. Die Kopfzahl IST die Summe der aufgefuehrten Transfers. Genau diese
 *      Zusage war einmal gebrochen: die Summe kam aus der Tagesbilanz der
 *      Bridge, die Empfaengerliste aus den Zeitstempeln der Transfers - und
 *      weil beide Seiten den Tag anders abgrenzen, stand ueber einem einzigen
 *      Transfer von 3,0 Millionen eine Ueberschrift von 6,97 Millionen.
 *
 * Sind mehr grosse Transfers vorhanden als aufgefuehrt (die Liste haelt zehn),
 * kann die Summe der Liste nur eine Untergrenze sein - dann wird auch nur das
 * geprueft.
 */
function brauchbar(r) {
  let empf;
  try {
    empf = r.top_recipients ? JSON.parse(r.top_recipients) : [];
  } catch {
    return false;
  }
  if (!empf.length) return false;
  if (!empf.some((e) => e.etn >= BRIDGE_MIN_TRANSFER_ETN)) return false;

  const summe = empf.reduce((s, e) => s + e.etn, 0);
  const vollstaendigGelistet = (r.recipient_count ?? empf.length) <= empf.length;
  // Ein Promille Spielraum fuer die Wei-nach-ETN-Umrechnung.
  const abweichung = Math.abs(r.outflow_etn - summe) / (r.outflow_etn || 1);
  return vollstaendigGelistet ? abweichung < 0.001 : summe <= r.outflow_etn * 1.001;
}

async function bridge_events_api(db) {
  const alle = (
    await db.prepare("SELECT * FROM bridge_events ORDER BY outflow_etn DESC LIMIT 40").all()
  ).results;

  const rows = alle.filter((r) => brauchbar(r)).slice(0, 12);
  // Wie weit die Suche tatsaechlich zurueckreicht - sonst sieht "nichts
  // gefunden" fuer einen aelteren Zeitraum wie "nichts passiert" aus.
  //
  // Der Durchgang durch die Bridge-Historie laeuft ueber mehrere Laeufe
  // hinweg (siehe src/bridge-events.js); bis er durch ist, waechst das
  // abgedeckte Fenster von Woche zu Woche. Solange gehoert beides in die
  // Antwort: wie weit zurueck, und ob das schon alles ist.
  //
  // Bewusst abgesichert: beide Tabellen kamen erst spaeter dazu. Auf einer
  // Datenbank ohne sie warf diese eine Zeile den KOMPLETTEN Endpoint mit 500
  // um, obwohl die Ereignisse laengst da waren.
  const lauf = await db
    .prepare("SELECT taken_at FROM bridge_event_runs ORDER BY id DESC LIMIT 1")
    .first()
    .catch(() => null);
  const stand = await db
    .prepare("SELECT aeltestes_bekannt, fertig FROM bridge_scan WHERE id = 1")
    .first()
    .catch(() => null);
  return {
    abgedeckt_ab: stand?.aeltestes_bekannt?.slice(0, 10) ?? null,
    historie_vollstaendig: !!stand?.fertig,
    geprueft_am: lauf?.taken_at ?? null,
    ereignisse: rows.map((r) => ({
      day: r.day,
      outflow_etn: r.outflow_etn,
      recipient_count: r.recipient_count,
      top_empfaenger: r.top_recipients ? JSON.parse(r.top_recipients) : [],
      unvollstaendig: false,
      analyzed_at: r.analyzed_at,
    })),
  };
}

/**
 * Netto-Fluss der bekannten Boersen-Wallets pro Tag.
 *
 * Positiv = ETN ist AUF die Boersen gewandert (haeufig gelesen als
 * Verkaufsbereitschaft), negativ = ETN ist von den Boersen ABGEFLOSSEN
 * (haeufig gelesen als Verwahrung im eigenen Wallet). Bewusst nur die
 * Beobachtung, keine Prognose - im Dashboard steht der Vorbehalt daneben.
 *
 * Kostet keine einzige zusaetzliche API-Anfrage: rechnet ausschliesslich auf
 * daily_balances, das der Backfill/Ingest ohnehin fuellt.
 *
 * Wichtig zur Rechnung: daily_balances enthaelt nur Tage MIT Aenderung. Die
 * Differenz wird darum immer zur vorherigen vorhandenen Zeile derselben
 * Adresse gebildet (Luecke = keine Bewegung), und ueber balance_wei/BigInt,
 * nie ueber die gerundete REAL-Spalte.
 */
async function exchange_flow(db, u) {
  const tage = ZEITRAUM[u.searchParams.get("period") ?? "30d"] ?? 30;
  const inklAuto = u.searchParams.get("incl_auto") === "1";
  const typen = inklAuto ? ["exchange", "service"] : ["exchange"];
  const platzhalter = typen.map(() => "?").join(",");

  const rows = (
    await db
      .prepare(
        "SELECT d.address, d.day, d.balance_wei, a.label, a.label_type" +
          " FROM daily_balances d JOIN addresses a ON a.hash = d.address" +
          " WHERE a.label_type IN (" + platzhalter + ")" +
          " ORDER BY d.address ASC, d.day ASC"
      )
      .bind(...typen)
      .all()
  ).results;

  const abTag = tagVor(tage);
  const proTag = new Map();      // day -> Wei-Summe (BigInt)
  const proBoerse = new Map();   // address -> { label, wei }
  let letzteAdresse = null;
  let letzterWert = null;

  for (const r of rows) {
    const wei = BigInt(r.balance_wei);
    if (r.address !== letzteAdresse) {
      letzteAdresse = r.address;
      letzterWert = wei;
      continue; // erste Zeile einer Adresse hat keine Vorgaengerin
    }
    const delta = wei - letzterWert;
    letzterWert = wei;
    if (delta === 0n || r.day < abTag) continue;

    proTag.set(r.day, (proTag.get(r.day) ?? 0n) + delta);
    const b = proBoerse.get(r.address) ?? {
      label: r.label ?? (r.label_type === "service" ? "Unknown exchange" : "Exchange"),
      bestaetigt: r.label_type === "exchange",
      wei: 0n,
    };
    b.wei += delta;
    proBoerse.set(r.address, b);
  }

  const zuEtn = (wei) => Number(wei / 10n ** 12n) / 1e6;
  const verlauf = [...proTag.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, wei]) => ({ day, netto_etn: zuEtn(wei) }));
  const netto = verlauf.reduce((s, v) => s + v.netto_etn, 0);
  const zufluss = verlauf.filter((v) => v.netto_etn > 0).reduce((s, v) => s + v.netto_etn, 0);
  const abfluss = verlauf.filter((v) => v.netto_etn < 0).reduce((s, v) => s + v.netto_etn, 0);

  return {
    zeitraum: u.searchParams.get("period") ?? "30d",
    inkl_auto: inklAuto,
    // Ehrlichkeit ueber die Abdeckung: nur was gelabelt ist, kann gezaehlt
    // werden - unbekannte Boersen-Wallets fehlen zwangslaeufig.
    boersen_gezaehlt: proBoerse.size,
    netto_etn: netto,
    zufluss_etn: zufluss,
    abfluss_etn: abfluss,
    verlauf,
    pro_boerse: [...proBoerse.entries()]
      .map(([address, b]) => ({ address, label: b.label, bestaetigt: b.bestaetigt, netto_etn: zuEtn(b.wei) }))
      .sort((a, b) => Math.abs(b.netto_etn) - Math.abs(a.netto_etn)),
  };
}

/**
 * Woher kam das ETN und wohin ging es? Grundlage der beiden Fluss-Diagramme
 * auf der Investigate-Seite.
 *
 * Bewusst live beim Explorer statt aus der Datenbank: Transaktionen werden
 * hier nirgends gespeichert (das waere bei 2 Mio. Adressen sinnlos), und die
 * Seite fragt immer nur EIN Wallet auf Wunsch ab. Die Antwort wird zwei
 * Minuten gecacht, wiederholtes Ansehen kostet also nichts.
 *
 * Aggregiert wird ueber balance_wei/BigInt, nie ueber gerundete Zahlen.
 */
async function wallet_flows(db, env, adresse, u) {
  const adr = adresse.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(adr)) return fehler("Keine gueltige Adresse");

  const zeitraum = u.searchParams.get("period") ?? "7d";
  const tage = ZEITRAUM[zeitraum] ?? 7;
  const abZeit = new Date(Date.now() - tage * 86400000).toISOString();
  const topN = Math.min(20, Math.max(3, Number(u.searchParams.get("top") ?? 12)));

  const { fetchInboundTransactions, fetchOutboundTransactions } = await import("./blockscout.js");
  const api = env.EXPLORER_API;
  const [rein, raus] = await Promise.all([
    fetchInboundTransactions(api, adr, { maxPages: 10, bisZeit: abZeit }),
    fetchOutboundTransactions(api, adr, { maxPages: 10, bisZeit: abZeit }),
  ]);

  /** Transfers einer Richtung nach Gegenpartei buendeln. */
  function buendeln(res) {
    const proPartei = new Map();
    let gesamt = 0n;
    let anzahl = 0;
    for (const t of res.transfers) {
      if (t.timestamp < abZeit) continue;      // ausserhalb des Fensters
      if (t.gegenpart === adr) continue;       // Selbstueberweisung
      const wei = BigInt(t.value_wei);
      if (wei === 0n) continue;                // reine Contract-Aufrufe
      const e = proPartei.get(t.gegenpart) ?? { wei: 0n, tx: 0 };
      e.wei += wei;
      e.tx++;
      proPartei.set(t.gegenpart, e);
      gesamt += wei;
      anzahl++;
    }
    const zuEtn = (w) => Number(w / 10n ** 12n) / 1e6;
    const sortiert = [...proPartei.entries()].sort((a, b) => (a[1].wei < b[1].wei ? 1 : -1));
    const oben = sortiert.slice(0, topN);
    const rest = sortiert.slice(topN);
    return {
      gesamt_etn: zuEtn(gesamt),
      tx_anzahl: anzahl,
      parteien: oben.map(([address, e]) => ({
        address, etn: zuEtn(e.wei), tx: e.tx,
        anteil: gesamt > 0n ? Number((e.wei * 10000n) / gesamt) / 10000 : 0,
      })),
      rest: rest.length
        ? {
            anzahl: rest.length,
            etn: zuEtn(rest.reduce((s, [, e]) => s + e.wei, 0n)),
            tx: rest.reduce((s, [, e]) => s + e.tx, 0),
          }
        : null,
      // Ehrlich bleiben: nur wenn der Seitendeckel griff, BEVOR das
      // Zeitfenster erreicht war, fehlen tatsaechlich Daten.
      gedeckelt: !res.vollstaendig,
    };
  }

  const inflow = buendeln(rein);
  const outflow = buendeln(raus);

  // Bekannte Namen ergaenzen, damit im Diagramm "KuCoin" statt Hex steht.
  const alle = [...inflow.parteien, ...outflow.parteien].map((p) => p.address);
  if (alle.length) {
    const platzhalter = alle.map(() => "?").join(",");
    const rows = (
      await db
        .prepare(
          "SELECT a.hash, a.label, a.ens_name, a.label_type, a.is_contract, c.etn" +
            " FROM addresses a LEFT JOIN current_balances c ON c.address = a.hash" +
            " WHERE a.hash IN (" + platzhalter + ")"
        )
        .bind(...alle)
        .all()
    ).results;
    const nach = new Map(rows.map((r) => [r.hash, r]));
    for (const p of [...inflow.parteien, ...outflow.parteien]) {
      const r = nach.get(p.address);
      if (!r) continue;
      p.anzeige = r.label ?? r.ens_name ?? null;
      p.label_type = r.label_type ?? null;
      p.is_contract = r.is_contract ?? 0;
      p.balance_etn = r.etn ?? null;
    }
  }

  return { address: adr, zeitraum, inflow, outflow };
}

/** Freie Wallet-Suche: erst lokal, sonst direkt beim Explorer nachschlagen. */
async function suche(db, env, q) {
  const adr = q.trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(adr)) {
    const lokal = await wallet(db, env, adr);
    if (lokal) return { quelle: "db", ...lokal };
    // Nicht in den Top N - live beim Explorer holen, damit jedes Wallet
    // seinen Tier sehen kann. Genau das macht das Tier-Feature nutzbar.
    const { fetchAddress } = await import("./blockscout.js");
    const live = await fetchAddress(env.EXPLORER_API, adr);
    const p = tierProgress(live.etn);
    return {
      quelle: "explorer",
      address: adr,
      etn: live.etn,
      balance_wei: live.balance_wei,
      tier: p.tier.key,
      tier_name: p.tier.name,
      tier_emoji: p.tier.emoji,
      tier_progress: p.progress,
      bis_naechster_tier: p.isTop ? null : p.needed,
      naechster_tier: p.next?.name ?? null,
      in_top_n: 0,
    };
  }
  // Namenssuche ueber Labels und .etn-Namen
  const rows = (
    await db
      .prepare(
        "SELECT " + WALLET_FELDER +
          " FROM current_balances c JOIN addresses a ON a.hash = c.address" +
          " WHERE a.label LIKE ? OR a.ens_name LIKE ? ORDER BY c.etn DESC LIMIT 25"
      )
      .bind("%" + q + "%", "%" + q + "%")
      .all()
  ).results;
  return { quelle: "db", treffer: rows.map((r) => schmuecken(r)) };
}

/* ---------- Netzwerk-Kennzahlen ----------------------------------------
 *
 * Die einzigen Zahlen im Dashboard, die NICHT aus der eigenen Datenbank
 * kommen, sondern direkt vom Explorer. Bewusst so:
 *
 *   - Sie aendern sich im Sekundentakt (Blockhoehe, Transaktionen). Alle 30
 *     Minuten einen Schnappschuss davon wegzuschreiben waere gleichzeitig zu
 *     langsam fuer die Anzeige und zu teuer fuer das D1-Schreibbudget.
 *   - Es sind Momentwerte ohne eigene Historie - es gibt nichts abzuleiten,
 *     was der Explorer nicht selbst schon fuehrt.
 *
 * Zwei Abfragen pro Aufruf, und die Antwort haengt eine Minute im
 * Worker-Cache. Faellt der Explorer aus, kommt eine leere Antwort statt
 * eines Fehlers: der Rest der Uebersicht soll deswegen nicht kippen.
 */
async function network(env) {
  const api = env.EXPLORER_API;
  const holen = async (pfad) => {
    const r = await fetch(api + pfad, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(pfad + ": HTTP " + r.status);
    return r.json();
  };

  let s, verlauf;
  try {
    [s, verlauf] = await Promise.all([
      holen("/stats"),
      holen("/stats/charts/transactions").catch(() => null),
    ]);
  } catch (e) {
    return { leer: true, grund: e.message };
  }

  const zahl = (v) => (v == null || v === "" ? null : Number(v));

  // Der neueste Eintrag der Reihe ist der LAUFENDE Tag - nachgeprueft: sein
  // Wert ist identisch mit transactions_today. Als Balken waere er ein
  // Einbruch auf halber Hoehe, im Schnitt zoege er die Linie nach unten.
  // Darum faellt er raus, und zwar ueber die Sortierung statt ueber einen
  // Datumsvergleich: die Tagesgrenze des Explorers ist nicht zwingend die
  // von UTC, und dann wuerde ein Vergleich mit "heute" danebenliegen.
  const tage = (verlauf?.chart_data ?? [])
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(1, 31)
    .reverse()
    .map((d) => ({ day: d.date, tx: zahl(d.transaction_count) }));

  return {
    blockhoehe: zahl(s.total_blocks),
    transaktionen: zahl(s.total_transactions),
    tx_heute: zahl(s.transactions_today),
    adressen: zahl(s.total_addresses),
    blockzeit_ms: zahl(s.average_block_time),
    auslastung: zahl(s.network_utilization_percentage),
    gas_used_heute: zahl(s.gas_used_today),
    gaspreis: zahl(s.gas_prices?.average),
    preis: zahl(s.coin_price),
    marktkapitalisierung: zahl(s.market_cap),
    tx_verlauf: tage,
    tx_schnitt: tage.length ? tage.reduce((a, b) => a + b.tx, 0) / tage.length : null,
  };
}

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const pfad = u.pathname;

    if (!pfad.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // Trigger/Status der Hintergrund-Jobs niemals cachen: der Knopf muss den
    // aktuellen Sperrzustand sehen, nicht eine bis zu 2 Minuten alte Antwort,
    // und ein POST darf ohnehin nie aus dem Cache beantwortet werden.
    // Telegram-Webhook: nie cachen, kein GET, eigener Erfolgs-Response (immer
    // 200 "ok", damit Telegram nicht endlos wiederholt zustellt).
    if (pfad === "/api/telegram/webhook") {
      if (request.method !== "POST") return new Response("POST erforderlich", { status: 405 });
      return handleTelegramWebhook(request, env, env.DB);
    }

    const jobMatch = pfad.match(/^\/api\/(census|clusters|exchanges|bridge)\/(status|trigger)$/);
    if (jobMatch) {
      const [, name, art] = jobMatch;
      try {
        if (art === "status") {
          const s = await job_status(env.DB, name);
          // Das Dashboard blendet die Knoepfe aus, wenn ein Token noetig ist
          // und der Besucher keines hat - besser als ein Knopf, der nur 403 kann.
          return json({ ...s, admin_noetig: !!env.ADMIN_TOKEN, admin_ok: adminOk(request, env) }, 200, 0);
        }
        if (request.method !== "POST") return fehler("POST erforderlich", 405);
        if (!adminOk(request, env)) {
          return json({ ok: false, grund: "kein_zugriff", hinweis: "Dieser Knopf ist dem Betreiber vorbehalten." }, 403, 0);
        }
        const res = await job_trigger(env.DB, env, name);
        return json(res, res.ok ? 200 : 409, 0);
      } catch (e) {
        return json({ error: e.message }, 500, 0);
      }
    }

    // Antworten kurz zwischenspeichern - die Daten aendern sich nur alle 30 Min.
    const cache = caches.default;
    const treffer = await cache.match(request);
    if (treffer) return treffer;

    let antwort;
    try {
      const db = env.DB;
      if (pfad === "/api/overview") antwort = json(await overview(db, env));
      else if (pfad === "/api/network") antwort = json(await network(env), 200, 60);
      else if (pfad === "/api/price") antwort = json(await preisverlauf(env, u), 200, 300);
      else if (pfad === "/api/clusters") antwort = json(await clusters_api(db));
      else if (pfad === "/api/bridge-events") antwort = json(await bridge_events_api(db));
      else if (pfad === "/api/leaderboard") antwort = json(await leaderboard(db, env, u));
      else if (pfad === "/api/movers") antwort = json(await movers(db, env, u));
      else if (pfad === "/api/sleepers") antwort = json(await sleepers(db, env, u));
      else if (pfad === "/api/events") antwort = json(await events(db, u));
      else if (pfad === "/api/watchlist") antwort = json(await watchlist(db, env, u), 200, 30);
      else if (pfad === "/api/exchange-flow") antwort = json(await exchange_flow(db, u));
      else if (pfad === "/api/tiers") antwort = json({ tiers: TIERS });
      else if (pfad === "/api/search") {
        const q = u.searchParams.get("q");
        antwort = q ? json(await suche(db, env, q)) : fehler("Parameter q fehlt");
      } else if (pfad.startsWith("/api/wallet-flows/")) {
        antwort = json(await wallet_flows(db, env, pfad.slice("/api/wallet-flows/".length), u));
      } else if (pfad.startsWith("/api/wallet/")) {
        const w = await wallet(db, env, pfad.slice("/api/wallet/".length));
        antwort = w ? json(w) : fehler("Wallet nicht gefunden", 404);
      } else antwort = fehler("Unbekannter Endpoint", 404);
    } catch (e) {
      antwort = json({ error: e.message, stack: String(e.stack).split("\n")[1] }, 500, 0);
    }

    if (antwort.status === 200) ctx.waitUntil(cache.put(request, antwort.clone()));
    return antwort;
  },
};
