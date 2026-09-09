// Cloudflare Worker: liefert das Dashboard und die JSON-API.
//
// Der Worker LIEST nur. Das Einsammeln der Daten macht die GitHub Action
// (siehe .github/workflows/snapshot.yml), weil Workers Free nur 10 ms CPU pro
// Ausfuehrung erlaubt - fuer tausende Adressen zu wenig. Lesende Abfragen
// bleiben dagegen weit darunter, weil die Wartezeit auf D1 nicht als CPU zaehlt.

import { TIERS, tierProgress, tierFor, tierMax, FAST_TIER_MIN } from "./tiers.js";
import { clusterGruppen } from "./clusters.js";
import { handleTelegramWebhook } from "./telegram.js";
import { fetchAddress } from "./blockscout.js";

// Die Daten aendern sich nur alle 30 Minuten - zwei Minuten waren also
// fuenfzehnmal haeufiger nachgefragt als noetig. Bei Andrang ist das der
// Unterschied zwischen "haelt" und "Leselimit gerissen": jede Antwort, die
// aus dem Zwischenspeicher kommt, beruehrt die Datenbank gar nicht.
// Wie alt die Zahlen sind, sagt die Kopfzeile ohnehin ("snapshot X ago").
// 60 Sekunden. Der Snapshot kommt alle ~30 Minuten - laenger zu cachen macht
// die Zahlen also nicht stabiler, nur aelter. Zehn Minuten waren noetig,
// solange /api/overview 7.179 Zeilen je Cache-Miss las; seit der Snapshot-Lauf
// diese Zahlen vorberechnet (src/ingest.js, 7b), kostet ein Miss fast nichts.
const CACHE_SEKUNDEN = 60;

/* ---------- Live-Abfrage einzelner Wallets ------------------------------
 *
 * Wer ein Wallet aufschlaegt, soll den Bestand von JETZT sehen, nicht den vom
 * letzten Snapshot. Das kostet genau eine Anfrage an den Explorer - gegen die
 * ~2.900 taeglichen des Snapshot-Laufs ist das Rauschen, und es faellt nur an,
 * wenn wirklich jemand hinschaut.
 *
 * Zwei Sperren, beide ueber die Tabelle live_abrufe:
 *
 *   je Wallet   Innerhalb von LIVE_SPERRE_MS kein zweites Mal. Oeffnen hundert
 *               Leute denselben geteilten Link, kostet das EINE Anfrage.
 *   global      Hoechstens LIVE_PRO_MINUTE fuer die ganze Seite.
 *
 * Die Sperren stehen in D1 und nicht im Cache: Der Cache liegt je
 * Rechenzentrum getrennt, ein Deckel darin waere keiner. Die Datenbank ist
 * eine Instanz - hier gilt die Grenze wirklich global, auch bei zehntausend
 * Besuchern. Mehr Andrang heisst dann nicht mehr Last fuer den Explorer von
 * Electroneum, sondern nur oefter den gespeicherten statt einen frischen Wert.
 *
 * Greift eine Sperre, ist das kein Fehler: Dann zeigt die Seite den Stand aus
 * der Datenbank - der oft selbst erst Sekunden alt ist, weil der letzte
 * Live-Abruf zurueckgeschrieben wurde.
 */
const LIVE_SPERRE_MS = 60000;
const LIVE_PRO_MINUTE = 4;

async function liveBestand(db, env, adr, bekannt) {
  const jetzt = Date.now();
  try {
    const eigen = await db
      .prepare("SELECT geholt_am FROM live_abrufe WHERE address = ?")
      .bind(adr)
      .first();
    if (eigen && jetzt - Date.parse(eigen.geholt_am) < LIVE_SPERRE_MS) return null;

    const zaehler = await db
      .prepare("SELECT count(*) n FROM live_abrufe WHERE geholt_am >= ?")
      .bind(new Date(jetzt - 60000).toISOString())
      .first();
    if ((zaehler?.n ?? 0) >= LIVE_PRO_MINUTE) return null;

    const frisch = await fetchAddress(env.EXPLORER_API, adr);
    if (!frisch || frisch.balance_wei == null) return null;
    const zeit = new Date(jetzt).toISOString();

    const geaendert = String(bekannt?.balance_wei ?? "") !== String(frisch.balance_wei);
    const schreiben = [
      db
        .prepare(
          "INSERT INTO live_abrufe (address, geholt_am) VALUES (?,?)" +
            " ON CONFLICT(address) DO UPDATE SET geholt_am=excluded.geholt_am"
        )
        .bind(adr, zeit),
    ];

    if (geaendert) {
      // Bestand ja, Rang NEIN: Der Rang ergibt sich aus dem Vergleich mit
      // allen anderen, und die stehen noch auf dem Stand des letzten
      // Snapshots. Ihn hier mitzuziehen ergaebe eine Rangliste, in der zwei
      // Wallets denselben Platz belegen. Er wird beim naechsten Lauf richtig.
      //
      // updated_at nur bei echter Aenderung: Die Spalte markiert die letzte
      // BEWEGUNG und ist die Grundlage der Schlaefer-Erkennung. Sie bei jedem
      // Hinsehen fortzuschreiben wuerde ausgerechnet die Kernfrage des
      // Trackers zerstoeren - welche lange stillen Wallets aufwachen.
      schreiben.push(
        db
          .prepare(
            "UPDATE current_balances SET balance_wei = ?, etn = ?, updated_at = ?" +
              " WHERE address = ?"
          )
          .bind(String(frisch.balance_wei), frisch.etn, zeit, adr)
      );
    }
    await db.batch(schreiben);

    return { balance_wei: String(frisch.balance_wei), etn: frisch.etn, geholt_am: zeit };
  } catch {
    // Explorer stumm, Sperre nicht lesbar, was auch immer: Der gespeicherte
    // Stand ist immer noch eine gute Antwort. Nie deshalb die Seite brechen.
    return null;
  }
}

/**
 * Nur der Zeitstempel des letzten Snapshots - fuer das Nachladen im Browser.
 *
 * Absichtlich winzig: Eine offene Seite fragt hier jede Minute nach und laedt
 * erst dann wirklich neu, wenn sich der Wert geaendert hat. Wuerde sie
 * stattdessen im Takt alles neu ziehen, kostete jeder offene Tab zehn
 * Abfragen pro Minute.
 */
async function stand(db) {
  const r = await db
    .prepare("SELECT id, taken_at FROM snapshots WHERE status='ok' ORDER BY id DESC LIMIT 1")
    .first();
  return { snapshot_id: r?.id ?? null, taken_at: r?.taken_at ?? null };
}

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

/**
 * Zahl aus einem Abfrageparameter - mit Rueckfall und Grenzen.
 *
 * Number("abc") ist NaN, und NaN geht durch Math.min/Math.max unveraendert
 * hindurch: aus Math.min(200, Math.max(10, NaN)) wird wieder NaN. Genau so
 * landete "?limit=abc" als Bindungswert in der Abfrage und quittierte mit 500.
 * Einmal hier abgefangen statt an zehn Aufrufstellen.
 */
function zahlParam(u, name, standard, min = -Infinity, max = Infinity) {
  const roh = u.searchParams.get(name);
  const n = roh == null || roh === "" ? standard : Number(roh);
  if (!Number.isFinite(n)) return standard;
  return Math.min(max, Math.max(min, n));
}

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

/**
 * Vorberechnete Kennzahlen des letzten Snapshots - eine gelesene Zeile.
 *
 * Gibt null zurueck, wenn es sie (noch) nicht gibt: frisch aufgesetzt, oder
 * der Snapshot-Lauf hat seit dem Deploy noch nicht gearbeitet. Jeder Aufrufer
 * rechnet dann wie frueher selbst - langsamer und teurer, aber die Seite
 * steht nie still, nur weil eine Optimierung noch nicht gegriffen hat.
 */
async function kennzahlen(db) {
  try {
    const row = await db.prepare("SELECT daten FROM kennzahlen WHERE id = 1").first();
    return row?.daten ? JSON.parse(row.daten) : null;
  } catch {
    return null;
  }
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

  // Gemessen am 08.09.2026: die drei Abfragen hier lasen zusammen 7.179
  // Zeilen - dreimal ein voller Durchlauf durch current_balances, um zwanzig
  // Zahlen anzuzeigen. Ein Index half nicht, in_top_n ist bei fast allen
  // Zeilen gleich. Der Snapshot-Lauf hat die Zahlen ohnehin im Speicher und
  // legt sie ab (src/ingest.js, Abschnitt 7b); hier kostet das eine Zeile.
  const kz = await kennzahlen(db);

  const proTier =
    kz?.pro_tier ??
    (await db
      .prepare(
        "SELECT " + faelle + " FROM current_balances WHERE in_top_n=1 AND address != ?"
      )
      .bind(String(env.BRIDGE_ADDRESS).toLowerCase())
      .first()) ??
    {};

  const grenze = kz?.grenze
    ? { m: kz.grenze.min_etn, n: kz.grenze.anzahl }
    : await db
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

  const schlaefer =
    kz?.schlaefer ??
    (
      await db
        .prepare(
          "SELECT COUNT(*) anzahl, SUM(etn) etn FROM current_balances" +
            " WHERE etn >= 1000000 AND updated_at <= ? AND address != ?"
        )
        .bind(
          new Date(Date.now() - 90 * 86400000).toISOString(),
          String(env.BRIDGE_ADDRESS).toLowerCase()
        )
        .all()
    ).results?.[0] ??
    null;

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
    schlaefer,
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

/**
 * Rangliste ohne Filter - der Weg, den fast jeder Aufruf nimmt.
 *
 * Liest nur die angezeigte Seite plus deren Vergangenheit, statt die ganze
 * Liste durchzurechnen. Was dabei entfaellt, ist die Rangaenderung: sie
 * verlangt den Bestand ALLER Wallets von damals. Die Δ-Spalte in ETN und
 * Prozent bleibt, sie braucht nur die Vergangenheit der gezeigten Zeilen.
 */
async function leaderboardSchnell(db, env, u, { limit, offset, tage }) {
  const bridge = String(env.BRIDGE_ADDRESS).toLowerCase();
  const [res, gesamt] = await Promise.all([
    db
      .prepare(
        "SELECT " + WALLET_FELDER +
          ", (SELECT d.etn FROM daily_balances d WHERE d.address = c.address AND d.day <= ?" +
          "   ORDER BY d.day DESC LIMIT 1) AS etn_vorher" +
          ", (SELECT d.etn FROM daily_balances d WHERE d.address = c.address" +
          "   ORDER BY d.day ASC LIMIT 1) AS etn_erster" +
          ", (SELECT d.day FROM daily_balances d WHERE d.address = c.address" +
          "   ORDER BY d.day ASC LIMIT 1) AS tag_erster" +
          " FROM current_balances c LEFT JOIN addresses a ON a.hash = c.address" +
          " WHERE c.in_top_n = 1 AND c.address != ?" +
          " ORDER BY c.etn DESC LIMIT ? OFFSET ?"
      )
      .bind(tagVor(tage), bridge, limit, offset)
      .all(),
    db
      .prepare("SELECT COUNT(*) n FROM current_balances WHERE in_top_n = 1 AND address != ?")
      .bind(bridge)
      .first(),
  ]);

  const jetzt = Date.now();
  return {
    zeitraum: u.searchParams.get("period") ?? STD_ZEITRAUM,
    gesamt: gesamt?.n ?? 0,
    offset,
    limit,
    eintraege: res.results.map((r, i) => ({
      ...schmuecken(r, jetzt),
      platz: offset + i + 1,
      rang_delta: null, // siehe oben: braeuchte den Bestand aller Wallets von damals
      ...delta(r, tage, jetzt),
    })),
  };
}

async function leaderboard(db, env, u) {
  const limit = zahlParam(u, "limit", 50, 10, 250);
  const offset = zahlParam(u, "offset", 0, 0, 100000);
  const tage = ZEITRAUM[u.searchParams.get("period") ?? STD_ZEITRAUM] ?? 7;
  const tier = u.searchParams.get("tier");
  // "Nur echte Wallets": Bridge, Boersen UND Contracts raus. Uebrig bleibt,
  // was tatsaechlich einer Person oder Gruppe gehoert.
  const nurEcht = u.searchParams.get("nur_wallets") === "1";
  // Das genaue Gegenteil davon: Boersen, Bridges, Dienste und Contracts.
  // In den Top 3.000 sind das 17 Adressen - handlich genug, um sie am Stueck
  // anzusehen.
  const nurDienste = u.searchParams.get("nur_dienste") === "1";
  // Balance-Bereich, z.B. "zeig mir nur 100k-500k ETN".
  const minEtn = u.searchParams.has("min_etn") ? zahlParam(u, "min_etn", NaN) : null;
  const maxEtn = u.searchParams.has("max_etn") ? zahlParam(u, "max_etn", NaN) : null;

  const filter =
    " WHERE c.in_top_n = 1 AND c.address != ?" +
    (tier ? " AND c.tier = ?" : "") +
    (minEtn != null ? " AND c.etn >= ?" : "") +
    (maxEtn != null ? " AND c.etn <= ?" : "") +
    (nurEcht
      ? " AND COALESCE(a.is_excluded,0) = 0" +
        " AND COALESCE(a.label_type,'') NOT IN ('exchange','bridge','service')" +
        " AND COALESCE(a.is_contract,0) = 0"
      : "") +
    (nurDienste
      ? // Als Vorauswahl und nicht als Bedingung auf dem JOIN: So kann die
        // Datenbank den Teilindex idx_addresses_markiert benutzen, der genau
        // diese rund zwanzig Adressen enthaelt. Gemessen 71 gelesene Zeilen
        // statt 6.012 - als OR-Bedingung auf a.* half kein Index, weil das
        // ORDER BY die ganze Liste durchgehen liess, um siebzehn Treffer zu
        // finden.
        " AND c.address IN (SELECT hash FROM addresses" +
        "   WHERE label_type IS NOT NULL OR is_excluded = 1 OR is_contract = 1)"
      : "");

  const filterArgs = [String(env.BRIDGE_ADDRESS).toLowerCase()];
  if (tier) filterArgs.push(tier);
  if (minEtn != null) filterArgs.push(minEtn);
  if (maxEtn != null) filterArgs.push(maxEtn);

  // ---- Schneller Weg: ohne Filter braucht es keine Rangberechnung -------
  //
  // Gemessen an der echten Datenbank: die Abfrage unten liest 15.014 Zeilen,
  // weil sie fuer ALLE 3.000 Wallets den Bestand von damals nachschlaegt - nur
  // um daraus die Rangaenderung zu bilden. Das Gratis-Limit von D1 sind fuenf
  // Millionen gelesene Zeilen am Tag; damit waeren rund 330 Aufrufe moeglich.
  //
  // Ohne Filter ist der Rang aber schlicht die Position in der nach Bestand
  // sortierten Liste - und dafuer gibt es einen Index. Dieselbe Seite kostet
  // so 50 statt 15.014 Zeilen. Genau dieser Weg wird beim Aufruf der Seite
  // genommen; die teure Fassung bleibt fuer die Filter, die selten und dann
  // bewusst benutzt werden.
  const ohneFilter = !tier && minEtn == null && maxEtn == null && !nurEcht && !nurDienste;
  if (ohneFilter) return leaderboardSchnell(db, env, u, { limit, offset, tage });

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
    // Die Adresse als zweites Sortierkriterium: bei gleichem Bestand ist die
    // Reihenfolge sonst nicht festgelegt, und zwei Wallets mit demselben
    // Betrag koennten zwischen zwei Aufrufen die Plaetze tauschen - im
    // Leaderboard als erfundene Rangaenderung sichtbar.
    "  SELECT *, ROW_NUMBER() OVER (ORDER BY etn DESC, address) AS platz," +
    "         ROW_NUMBER() OVER (ORDER BY COALESCE(etn_vorher, etn) DESC, address) AS platz_vorher" +
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
  const limit = zahlParam(u, "limit", 10, 1, 50);
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
  // Rang von damals - erst JETZT nachschlagen, fuer die zwanzig angezeigten
  // Zeilen statt fuer alle dreitausend.
  //
  // Der Rang laesst sich nicht aus dem Bestand ableiten: Er verschiebt sich
  // auch, wenn ein Wallet selbst nichts tut - bewegt sich jemand darueber,
  // rutscht es ohne eigenes Zutun. Darum haelt der Snapshot-Lauf ihn einmal
  // taeglich fest (Tabelle daily_ranks).
  //
  // Als Teil der grossen Abfrage kostete dieser Nachschlag gemessene 3.110
  // zusaetzliche Zeilen, weil er vor dem Sortieren fuer jede Zeile lief. Hier
  // sind es ueber den Primaerschluessel (address, day) ein paar Dutzend.
  const gezeigt = [...gewinner.results, ...verlierer.results];
  const rangVorher = new Map();
  if (gezeigt.length) {
    const platzhalter = gezeigt.map(() => "?").join(",");
    try {
      const rows = (
        await db
          .prepare(
            "SELECT address, rank_pos, max(day) FROM daily_ranks" +
              " WHERE day <= ? AND address IN (" + platzhalter + ")" +
              " GROUP BY address"
          )
          .bind(tagVor(tage), ...gezeigt.map((r) => r.address))
          .all()
      ).results;
      for (const r of rows) rangVorher.set(r.address, r.rank_pos);
    } catch {
      // Tabelle noch nicht angelegt oder leer: Dann bleibt die Spalte eben
      // leer. Eine fehlende Zusatzangabe darf die Liste nicht kosten.
    }
  }

  const jetzt = Date.now();
  const auf = (r) => {
    const rv = rangVorher.get(r.address) ?? null;
    return {
      ...schmuecken(r, jetzt),
      delta_etn: r.etn - r.etn_vorher,
      delta_pct: r.etn_vorher ? ((r.etn - r.etn_vorher) / r.etn_vorher) * 100 : null,
      // Die kleinere Zahl ist der bessere Platz: von Rang 12 auf 14 sind -2.
      rang_vorher: rv,
      rang_delta: rv != null && r.rank_pos != null ? rv - r.rank_pos : null,
    };
  };
  return {
    zeitraum: u.searchParams.get("period") ?? STD_ZEITRAUM,
    snapshot_taken_at: snap?.taken_at ?? null,
    gewinner: gewinner.results.map(auf),
    verlierer: verlierer.results.map(auf),
  };
}

async function sleepers(db, env, u) {
  const minEtn = zahlParam(u, "min_etn", 1000000, 0);
  const minTage = zahlParam(u, "min_tage", 90, 0, 3650);
  const limit = zahlParam(u, "limit", 50, 1, 200);
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

/* ---------- Rueckmeldungen ----------------------------------------------
 *
 * Drei Bremsen gegen Missbrauch, alle ohne Konto und ohne Captcha:
 *
 *   Honigtopf   Ein Feld, das niemand sieht und darum niemand ausfuellt.
 *               Ist es gefuellt, tun wir so, als haette es geklappt - eine
 *               Fehlermeldung wuerde dem Absender nur verraten, dass wir es
 *               gemerkt haben.
 *   Rate        Fuenf Nachrichten je Stunde und Absender.
 *   Laenge      Zugeschnitten, statt beliebig viel zu speichern.
 */
const FEEDBACK_MAX_LAENGE = 1200;
const FEEDBACK_MAX_ABSENDER = 60;
const FEEDBACK_PRO_STUNDE = 5;

/** Kurzer Hash aus IP und Tag - reicht zum Bremsen, taugt nicht zum Erkennen. */
async function absenderHash(request) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unbekannt";
  const roh = new TextEncoder().encode(ip + "|" + new Date().toISOString().slice(0, 10));
  const digest = await crypto.subtle.digest("SHA-256", roh);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function feedbackSenden(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ungueltige Anfrage." }, 400, 0);
  }

  if (body.hp) return json({ ok: true }, 200, 0); // Honigtopf

  const nachricht = String(body.nachricht ?? "").trim().slice(0, FEEDBACK_MAX_LAENGE);
  const absender = String(body.absender ?? "").trim().slice(0, FEEDBACK_MAX_ABSENDER) || null;
  const seite = String(body.seite ?? "").trim().slice(0, 40) || null;
  if (!nachricht) return json({ error: "Die Nachricht ist leer." }, 400, 0);

  const hash = await absenderHash(request);
  const seitEinerStunde = new Date(Date.now() - 3600000).toISOString();
  const bisher = await db
    .prepare("SELECT count(*) n FROM feedback WHERE ip_hash = ? AND ts >= ?")
    .bind(hash, seitEinerStunde)
    .first();
  if ((bisher?.n ?? 0) >= FEEDBACK_PRO_STUNDE) {
    return json({ error: "Zu viele Nachrichten in kurzer Zeit. Bitte spaeter noch einmal." }, 429, 0);
  }

  await db
    .prepare("INSERT INTO feedback (ts, nachricht, absender, seite, ip_hash) VALUES (?,?,?,?,?)")
    .bind(new Date().toISOString(), nachricht, absender, seite, hash)
    .run();

  return json({ ok: true }, 200, 0);
}

/* ---------- Besuchszaehlung --------------------------------------------
 *
 * Zaehlt, wie viele verschiedene Menschen die Seite benutzen, wie lange sie
 * bleiben und wie viel sie klicken. Bewusst selbst gebaut statt mit einem
 * fremden Dienst: kein Konto, keine laufenden Kosten, keine Daten bei Dritten.
 *
 * EINE Zeile je BESUCH, nicht je Klick. Der Browser sammelt waehrend des
 * Besuchs und meldet beim Verlassen einmal die Zusammenfassung. Bei tausend
 * Besuchern taeglich sind das tausend geschriebene Zeilen; je Klick waeren es
 * Zehntausende, und das Gratis-Schreibbudget sind 100.000 am Tag.
 *
 * WER GEZAEHLT WIRD: nur wer sich wirklich bewegt hat - Maus, Tastatur,
 * Scrollen, Beruehrung. Crawler fuehren entweder kein JavaScript aus oder
 * bewegen nichts, und sie fallen damit heraus, ohne dass irgendjemand eine
 * Bot-Liste pflegen muesste. Auch die eigenen Pruefabrufe zaehlen nicht mit:
 * die bewegen nie eine Maus.
 *
 * WER NICHT ERKENNBAR WIRD: "besucher" ist ein kurzer Hash aus IP UND TAG. Er
 * wechselt jede Nacht, laesst sich nicht zurueckrechnen und folgt niemandem
 * ueber Tage. Kein Cookie, kein localStorage, keine Kennung im Geraet - es
 * gibt also nichts, wofuer eine Einwilligung einzuholen waere. Er reicht
 * genau fuer "wie viele verschiedene Leute waren heute da" und fuer nichts
 * darueber hinaus. Dasselbe Verfahren bremst schon das Feedback-Formular.
 */
const BESUCH_MAX_DAUER = 4 * 3600; // laenger ist ein vergessener Tab, kein Besuch
const BESUCH_MAX_KLICKS = 2000;
const BESUCH_PRO_STUNDE = 30; // Bremse gegen erfundene Zahlen
// Frueher kann kein Erstbesuch liegen - die Zaehlung gibt es seit dem
// 08.09.2026. Ein Datum davor ist entweder eine falsch gestellte Uhr oder
// jemand, der am Wert gedreht hat.
const BESUCH_START = "2026-09-08";

async function besuchMelden(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: true }, 200, 0); // nie mit Fehlern um sich werfen
  }

  const zahl = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const dauer = zahl(body.dauer_s, BESUCH_MAX_DAUER);
  const klicks = zahl(body.klicks, BESUCH_MAX_KLICKS);
  // Unter drei Sekunden ohne einen einzigen Klick ist kein Besuch, sondern
  // ein Blick und ein Zurueck.
  if (dauer < 3 && klicks === 0) return json({ ok: true }, 200, 0);

  const sauber = (v, n) =>
    String(v ?? "").trim().slice(0, n).replace(/[^a-zA-Z0-9 ,.:\/-]/g, "") || null;

  const hash = await absenderHash(request);
  const jetzt = new Date();
  const seitEinerStunde = new Date(jetzt.getTime() - 3600000).toISOString();
  const bisher = await db
    .prepare("SELECT count(*) n FROM besuche WHERE besucher = ? AND ts >= ?")
    .bind(hash, seitEinerStunde)
    .first();
  if ((bisher?.n ?? 0) >= BESUCH_PRO_STUNDE) return json({ ok: true }, 200, 0);

  // Erstbesuch dieses Geraets, taggenau. Geprueft statt uebernommen: der Wert
  // kommt aus dem Browser und koennte alles sein. Alles ausserhalb des
  // plausiblen Fensters - Zukunft, oder aelter als die Seite selbst - wird
  // verworfen statt gebogen, sonst stuenden erfundene Daten in der Statistik.
  let erst = null;
  {
    const roh = String(body.erst ?? "");
    const heute = new Date().toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(roh) && roh >= BESUCH_START && roh <= heute) erst = roh;
  }

  // Nur die Domain, nie der volle Verweis: Der Pfad einer fremden Seite kann
  // verraten, wonach jemand gesucht hat.
  let herkunft = null;
  try {
    const r = String(body.herkunft ?? "");
    if (r) herkunft = new URL(r).hostname.replace(/^www\./, "").slice(0, 60);
  } catch {
    herkunft = null;
  }

  // Der Schreibvorgang darf den Besucher NIE erreichen. Faellt er aus - fehlende
  // Spalte nach einem Deploy vor der Migration, erschoepftes Schreibkontingent,
  // was auch immer - ist die Zaehlung fuer diesen Besuch verloren und sonst
  // nichts. Ein 500 auf dem Weg nach draussen waere der teuerste denkbare Preis
  // fuer eine Statistik.
  try {
  await db
    .prepare(
      "INSERT INTO besuche (ts, tag, besucher, dauer_s, klicks, bereiche, einstieg," +
        " herkunft, geraet, erstbesuch) VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(
      jetzt.toISOString(),
      jetzt.toISOString().slice(0, 10),
      hash,
      dauer,
      klicks,
      sauber(body.bereiche, 120),
      sauber(body.einstieg, 20),
      herkunft,
      body.mobil ? "mobil" : "desktop",
      erst
    )
    .run();
  } catch {
    /* siehe oben - Zaehlen ist Beiwerk */
  }

  return json({ ok: true }, 200, 0);
}

/** Auswertung - nur fuer den Betreiber. */
async function besucheLesen(db, u) {
  const tage = zahlParam(u, "tage", 14, 1, 90);
  const abTag = tagVor(tage);

  const [proTag, gesamt, bereiche, herkunft] = await Promise.all([
    db
      .prepare(
        // Alles je Tag, alles in derselben Einheit: LEUTE. Die Gesamtwerte
        // entstehen daraus durch Addition (siehe unten) - damit steht in der
        // Kachel nie etwas, das sich nicht aus der Tagesliste nachrechnen
        // laesst. "besuche" zaehlt daneben jeden einzelnen Aufruf, auch den
        // dritten am selben Tag.
        "SELECT tag, count(DISTINCT besucher) leute, count(*) besuche," +
          " sum(klicks) klicks, avg(dauer_s) dauer," +
          " count(DISTINCT CASE WHEN erstbesuch < tag THEN besucher END) wieder," +
          " count(DISTINCT CASE WHEN julianday(tag) - julianday(erstbesuch) >= 7" +
          "   THEN besucher END) stamm" +
          " FROM besuche WHERE tag >= ? GROUP BY tag ORDER BY tag DESC"
      )
      .bind(abTag)
      .all(),
    db
      .prepare(
        "SELECT count(DISTINCT besucher) leute, count(*) besuche, sum(klicks) klicks," +
          " avg(dauer_s) dauer, sum(CASE WHEN geraet='mobil' THEN 1 ELSE 0 END) mobil" +
          " FROM besuche WHERE tag >= ?"
      )
      .bind(abTag)
      .first(),
    db
      .prepare("SELECT bereiche FROM besuche WHERE tag >= ? AND bereiche IS NOT NULL LIMIT 2000")
      .bind(abTag)
      .all(),
    db
      .prepare(
        "SELECT herkunft, count(*) n FROM besuche WHERE tag >= ? AND herkunft IS NOT NULL" +
          " GROUP BY herkunft ORDER BY n DESC LIMIT 12"
      )
      .bind(abTag)
      .all(),
  ]);

  // Reiter zaehlen: steht als kommagetrennte Liste je Besuch, hier
  // zusammengezaehlt - dafuer lohnt keine eigene Tabelle.
  const proBereich = {};
  for (const z of bereiche.results ?? []) {
    for (const b of String(z.bereiche).split(",")) {
      const k = b.trim();
      if (k) proBereich[k] = (proBereich[k] ?? 0) + 1;
    }
  }

  // Die Wiederkehr-Summen werden addiert statt neu abgefragt: so kann die
  // Kachel gar nicht etwas anderes sagen als die Tagesliste darunter.
  const tageReihe = proTag.results ?? [];
  const summe = (feld) => tageReihe.reduce((n, t) => n + (t[feld] ?? 0), 0);

  return {
    zeitraum_tage: tage,
    gesamt: gesamt
      ? {
          ...gesamt,
          leute_tage: summe("leute"), // Personen je Tag, ueber alle Tage addiert
          wieder: summe("wieder"),
          stamm: summe("stamm"),
        }
      : null,
    pro_tag: tageReihe,
    bereiche: Object.entries(proBereich)
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n),
    herkunft: herkunft.results ?? [],
  };
}

/** Posteingang - nur fuer den Betreiber. */
async function feedbackLesen(db) {
  const rows = (
    await db
      .prepare("SELECT id, ts, nachricht, absender, seite FROM feedback ORDER BY id DESC LIMIT 100")
      .all()
  ).results;
  return { eintraege: rows };
}

/* ---------- Kursverlauf ------------------------------------------------
 *
 * Kommt ausschliesslich aus der eigenen Datenbank. Drei Anlaeufe mit fremden
 * Zugaengen sind vorher gescheitert, und zwar nicht an der Programmierung:
 *
 *   Block-Explorer   Kursreihe auf 30 Tage festgenagelt (?days= und
 *                    ?resolution= gegengeprueft, wirkungslos), Kursfeld nur
 *                    fuer den neuesten Tag gefuellt.
 *   CoinGecko        403 ohne User-Agent - Workers schicken keinen. Mit
 *                    Kennung dann 429: das Gratis-Kontingent haengt an der
 *                    IP, und Worker teilen sich ihre Adressen mit allen.
 *   Coinpaprika      402 aus dem Worker heraus, waehrend dieselbe URL von
 *                    einem gewoehnlichen Anschluss 200 liefert.
 *
 * Gegen fremde IP-Sperren ist nichts auszurichten. Also wurde die
 * Vergangenheit EINMAL geholt (scripts/price-backfill.mjs -> price_history)
 * und wird seither aus den eigenen Snapshots weitergeschrieben. Damit ist der
 * Kurs so verfuegbar wie alles andere hier: ohne fremde Zusage, ohne
 * Kontingent, ohne Schluessel.
 *
 *   bis 24 Stunden   snapshots, alle 30 Minuten ein Punkt
 *   darueber         price_history (Vergangenheit) + network_daily (seither),
 *                    plus der aktuelle Kurs als letzter Punkt - sonst endete
 *                    die Kurve beim Stand von Mitternacht, waehrend darueber
 *                    gross der Kurs von jetzt steht.
 */
const KURS_ZEITRAUM = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

// Auf 700 Pixel Breite ist jeder zweite Punkt einer feineren Reihe unsichtbar
// und kostet nur Uebertragung.
const KURS_MAX_PUNKTE = 320;

function ausduennen(punkte, max = KURS_MAX_PUNKTE) {
  if (punkte.length <= max) return punkte;
  const schritt = punkte.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(punkte[Math.floor(i * schritt)]);
  if (out[out.length - 1] !== punkte[punkte.length - 1]) out.push(punkte[punkte.length - 1]);
  return out;
}

async function preisverlauf(db, env, u) {
  const p = u.searchParams.get("period") ?? "30d";
  const tage = KURS_ZEITRAUM[p] ?? 30;

  const snapshots = async (abZeit) =>
    (
      await db
        .prepare(
          "SELECT taken_at AS zeit, etn_price AS preis FROM snapshots" +
            " WHERE etn_price IS NOT NULL AND taken_at >= ? ORDER BY taken_at ASC"
        )
        .bind(abZeit)
        .all()
    ).results;

  // Kurze Zeitraeume aus den eigenen Snapshots: alle 30 Minuten ein Punkt,
  // feiner als jede Tagesreihe. Aber nur, wenn sie den Zeitraum auch wirklich
  // abdecken - sonst zeigte die 7-Tage-Kurve nach einer frisch aufgesetzten
  // Datenbank zwei Tage und behauptete, das seien sieben. Reicht die eigene
  // Historie nicht, uebernimmt weiter unten die Tagesreihe.
  if (tage <= 7) {
    const punkte = await snapshots(new Date(Date.now() - tage * 86400000).toISOString());
    const abgedeckt =
      punkte.length >= 2
        ? (Date.parse(punkte[punkte.length - 1].zeit) - Date.parse(punkte[0].zeit)) / 86400000
        : 0;
    if (abgedeckt >= tage * 0.85) {
      return { zeitraum: p, quelle: "snapshots", feinkoernig: true, punkte: ausduennen(punkte) };
    }
    if (tage === 1) {
      // Fuer einen Tag gibt es keinen Ersatz - die Tagesreihe haette dort
      // genau einen Punkt.
      return { zeitraum: p, quelle: "snapshots", feinkoernig: true, punkte: ausduennen(punkte) };
    }
  }

  // Tagesreihe: die nachgeladene Vergangenheit, dahinter die eigenen Tage.
  //
  // Beide Seiten muessen DIESELBE Tageszeit meinen, sonst entsteht an der
  // Nahtstelle ein Knick, der wie ein Fehler aussieht. Gemessen: die
  // nachgeladene Reihe fuehrt den Stand um 00:00, network_daily dagegen den
  // LETZTEN Snapshot des Tages - am 07.09. lagen die beiden dadurch 10
  // Prozent auseinander, obwohl beide Quellen sich auf 0,4 Prozent einig
  // sind. Darum hier nicht network_daily, sondern der jeweils FRUEHESTE
  // Snapshot eines Tages: das ist derselbe Tagesbeginn.
  //
  // Die nachgeladene Reihe gewinnt, wo es sie gibt; die eigenen Tage fuellen
  // alles auf, was danach kam.
  const abTag = new Date(Date.now() - tage * 86400000).toISOString().slice(0, 10);
  const tageReihe = (
    await db
      .prepare(
        "SELECT day AS zeit, preis, min(rang) FROM (" +
          "  SELECT day, preis, 1 AS rang FROM price_history WHERE day >= ?1" +
          "  UNION ALL" +
          "  SELECT substr(taken_at,1,10) AS day, etn_price AS preis, 2 AS rang" +
          "    FROM snapshots WHERE etn_price IS NOT NULL AND substr(taken_at,1,10) >= ?1" +
          "   GROUP BY substr(taken_at,1,10) HAVING taken_at = min(taken_at)" +
          ") GROUP BY day ORDER BY day ASC"
      )
      .bind(abTag)
      .all()
  ).results;

  // Der aktuelle Kurs als letzter Punkt.
  //
  // Zuerst aus den Netzwerk-Statistiken, die der Snapshot-Lauf ohnehin ablegt:
  // Der Explorer fuehrt den Kurs dort mit, und die Zahl ist damit so frisch wie
  // der letzte Lauf, ohne eine einzige zusaetzliche Anfrage. Sonst wie bisher
  // aus dem juengsten eigenen Snapshot.
  const kz = await kennzahlen(db);
  const kursJetzt = kz?.netz?.stats?.coin_price ? Number(kz.netz.stats.coin_price) : null;
  const jetzt =
    kursJetzt && Number.isFinite(kursJetzt)
      ? { zeit: (kz?.erstellt_am ?? new Date().toISOString()).slice(0, 19) + "Z", preis: kursJetzt }
      : (await snapshots(new Date(Date.now() - 86400000).toISOString())).pop();
  const punkte = [...tageReihe];
  if (jetzt && (!punkte.length || jetzt.zeit > punkte[punkte.length - 1].zeit)) punkte.push(jetzt);

  return {
    zeitraum: p,
    quelle: "eigene",
    feinkoernig: false,
    punkte: ausduennen(punkte),
    marken: await kursMarken(db, kursJetzt ?? jetzt?.preis ?? null),
  };
}

/**
 * Allzeithoch, Allzeittief und das 12-Monats-Hoch, jeweils mit dem Abstand
 * zum heutigen Kurs.
 *
 * Der Abstand wird HIER gerechnet und nicht gespeichert: Er aendert sich mit
 * jedem Kurs, die Marke selbst nur, wenn sie ueberboten wird.
 *
 * Ein Allzeithoch von 2018 kann diese Seite nicht selbst gemessen haben - es
 * kam einmalig von CoinGecko, weil keine kostenlose Quelle ihre Tagesreihe
 * weiter als 365 Tage zurueck herausgibt. Seither schreibt der Snapshot-Lauf
 * die Marken selbst fort.
 */
async function kursMarken(db, jetztPreis) {
  let rows;
  try {
    rows = (await db.prepare("SELECT schluessel, preis, tag, quelle FROM kurs_marken").all())
      .results;
  } catch {
    return null; // Tabelle noch nicht da: dann eben ohne
  }
  if (!rows?.length) return null;
  const abstand = (p) =>
    jetztPreis && p ? ((jetztPreis - p) / p) * 100 : null;
  return rows.map((r) => ({
    schluessel: r.schluessel,
    preis: r.preis,
    tag: r.tag,
    quelle: r.quelle,
    // Negativ = wir liegen darunter, positiv = darueber.
    abstand_pct: abstand(r.preis),
  }));
}

async function events(db, u) {
  const limit = zahlParam(u, "limit", 50, 1, 200);
  const typ = u.searchParams.get("type");
  const minSev = zahlParam(u, "min_severity", 0, 0, 100);
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

  // Bestand von JETZT statt vom letzten Snapshot - eine Anfrage, nur wenn
  // wirklich jemand hinsieht, und doppelt gedeckelt (siehe liveBestand).
  // Greift eine Sperre, bleibt es beim gespeicherten Stand; das ist kein
  // Fehler und wird auch nicht als solcher gemeldet.
  const live = await liveBestand(db, env, adr, r);
  if (live) {
    r.balance_wei = live.balance_wei;
    r.etn = live.etn;
  }

  return {
    ...schmuecken(r),
    // Der Rang bleibt der des letzten Snapshots, auch wenn der Bestand frisch
    // ist - er laesst sich nur im Vergleich mit allen anderen bestimmen.
    live: live ? { stand: live.geholt_am, rang_vom_snapshot: true } : null,
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
  // Der Bridge-Durchgang arbeitet sich ueber mehrere Laeufe durch die
  // Historie und setzt jedes Mal dort fort, wo er aufgehoert hat. Mit der
  // gleichen 24-Stunden-Sperre wie die anderen Jobs braeuchte das Wochen -
  // und ein fehlgeschlagener Lauf verbrennt den Versuch fuer den ganzen Tag.
  // Drei Stunden sind gegenueber dem Explorer immer noch zurueckhaltend.
  bridge: { workflow: "bridge-events.yml", runsTable: "bridge_event_runs", sperreMs: 3 * 3600000 },
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
    ? (job.sperreMs ?? TRIGGER_COOLDOWN_MS) - (Date.now() - Date.parse(letzterTrigger))
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

/* ---------- Bilanz zum Migrations-Stichtag -------------------------------
 *
 * Was die Migration am Ende gekostet hat: wie viel ETN nie herueberkam, was
 * das mit Umlaufmenge, Kurs und Marktkapitalisierung gemacht hat, und wer die
 * groessten Betraege noch rechtzeitig geholt hat.
 *
 * ABSICHTLICH SCHON VOR DEM STICHTAG SICHTBAR. Ein Bildschirm, der erst am
 * 31.01.2027 zum ersten Mal Daten bekommt, wird an genau diesem Tag zum
 * ersten Mal getestet - und das ist der eine Tag, an dem sich ein Fehler
 * nicht mehr reparieren laesst. Bis dahin steht in der "Nachher"-Spalte, was
 * ehrlich ist: noch nichts. Die "Vorher"-Seite arbeitet dagegen ab sofort mit
 * echten Zahlen.
 *
 * Die Vergleichspunkte kommen aus der Tabelle stichtag und werden am
 * jeweiligen Tag eingefroren (src/ingest.js, Abschnitt 7e). Nachtraeglich
 * liesse sich keiner davon rekonstruieren: der Bridge-Bestand laeuft weiter,
 * der Kurs erst recht.
 */
async function bilanz(db, env) {
  const stichtag = String(env.MIGRATION_DEADLINE ?? "2027-01-31");
  const basis = Date.parse(stichtag + "T00:00:00Z");
  const jetzt = Date.now();
  // Der Stichtag selbst muss vorbei sein, nicht nur angebrochen - sonst
  // stuende dort ein halber Tag als Ergebnis.
  const vorbei = jetzt >= basis + 86400000;
  const tageBis = Math.round((basis - jetzt) / 86400000);

  const marker = (
    await db.prepare("SELECT schluessel, tag, daten FROM stichtag").all()
  ).results;
  const punkte = {};
  for (const m of marker) {
    try {
      punkte[m.schluessel] = { tag: m.tag, ...JSON.parse(m.daten) };
    } catch {
      /* eine kaputte Zeile darf nicht die ganze Seite kosten */
    }
  }

  // Der heutige Stand, im selben Format wie ein eingefrorener Marker. Solange
  // noch kein einziger gesetzt ist, ist er die gesamte "Vorher"-Seite; danach
  // bleibt er die Spalte "heute".
  const [snap, netz] = await Promise.all([
    db
      .prepare(
        "SELECT taken_at, day, total_supply, bridge_wei, etn_price, addr_count," +
          " total_addresses FROM snapshots WHERE status='ok' ORDER BY id DESC LIMIT 1"
      )
      .first(),
    db.prepare("SELECT * FROM network_daily ORDER BY day DESC LIMIT 1").first(),
  ]);

  let heute = null;
  if (snap) {
    const bridgeEtn = snap.bridge_wei
      ? Number(BigInt(snap.bridge_wei) / 10n ** 12n) / 1e6
      : null;
    const supply = Number(snap.total_supply ?? 0);
    const zirk = supply - (bridgeEtn ?? 0);
    heute = {
      tag: snap.day,
      bridge_etn: bridgeEtn,
      total_supply: supply,
      zirkulierend: zirk,
      preis: snap.etn_price,
      marktkapitalisierung: snap.etn_price != null ? zirk * snap.etn_price : null,
      holder_1m: netz?.holders_1m ?? null,
      holder_5m: netz?.holders_5m ?? null,
      holder_10m: netz?.holders_10m ?? null,
      top10_anteil: netz?.top10_share ?? null,
      top100_anteil: netz?.top100_share ?? null,
      adressen_gesamt: snap.total_addresses ?? null,
      adressen_erfasst: snap.addr_count ?? null,
    };
  }

  // Was nie herueberkam. Vor dem Stichtag ist das eine Hochrechnung aus dem
  // heutigen Bestand, danach der festgehaltene Wert - beides klar getrennt,
  // damit niemand eine Schaetzung fuer eine Tatsache haelt.
  const amStichtag = punkte.T0 ?? null;
  const grundlage = amStichtag ?? heute;
  const verloren = grundlage
    ? {
        etn: grundlage.bridge_etn,
        anteil_supply:
          grundlage.total_supply > 0 ? grundlage.bridge_etn / grundlage.total_supply : null,
        wert_usd:
          grundlage.preis != null && grundlage.bridge_etn != null
            ? grundlage.bridge_etn * grundlage.preis
            : null,
        endgueltig: !!amStichtag,
      }
    : null;

  // Endspurt: zieht die Migration kurz vor Schluss an? Aus dem Bridge-Verlauf,
  // ohne eine einzige zusaetzliche Anfrage. Die Reihe enthaelt nur Tage MIT
  // Aenderung, darum wird jeweils der aelteste vorhandene Wert im Fenster
  // gegen den juengsten gerechnet, nicht Zeile gegen Zeile.
  const bReihe = (
    await db
      .prepare(
        "SELECT day, etn FROM daily_balances WHERE address = ? AND day >= ?" +
          " ORDER BY day ASC"
      )
      .bind(String(env.BRIDGE_ADDRESS).toLowerCase(), tagVor(60))
      .all()
  ).results;
  const abfluss = (von, bis) => {
    const f = bReihe.filter((r) => r.day >= von && r.day <= bis);
    return f.length >= 2 ? f[0].etn - f[f.length - 1].etn : null;
  };
  const endspurt = {
    letzte_30: abfluss(tagVor(30), tagVor(0)),
    davor_30: abfluss(tagVor(60), tagVor(30)),
  };
  endspurt.faktor =
    endspurt.davor_30 > 0 && endspurt.letzte_30 != null
      ? endspurt.letzte_30 / endspurt.davor_30
      : null;

  // Die groessten Einzelbetraege, die je die Bridge verlassen haben.
  //
  // Gelesen aus bridge_events, NICHT aus der Rohtabelle bridge_transfers: die
  // Ereignisse liegen fertig ausgewertet vor und enthalten je Tag die
  // Empfaenger mit Betrag, waehrend der Rohbestand erst existiert, wenn der
  // Durchgang durch die Bridge-Historie gelaufen ist. Genau daran hing diese
  // Liste zuerst - und war deshalb leer, obwohl dieselben Betraege eine
  // Bildschirmhoehe weiter oben standen.
  //
  // Warum die Sortierung nach Tagessumme reicht, um die groessten
  // EINZELbetraege zu finden: ein einzelner Transfer kann nie groesser sein
  // als die Summe seines Tages. Die zehn groessten Einzelbetraege stecken
  // damit zwangslaeufig in den Tagen mit den groessten Summen.
  const [ereignisse, stand] = await Promise.all([
    db
      .prepare(
        "SELECT day, top_recipients FROM bridge_events WHERE top_recipients IS NOT NULL" +
          " ORDER BY outflow_etn DESC LIMIT 60"
      )
      .all(),
    db
      .prepare("SELECT aeltestes_bekannt, fertig FROM bridge_scan WHERE id = 1")
      .first()
      .catch(() => null),
  ]);

  const transfers = [];
  for (const e of ereignisse.results ?? []) {
    let liste;
    try {
      liste = JSON.parse(e.top_recipients);
    } catch {
      continue; // eine kaputte Zeile darf die Liste nicht kosten
    }
    for (const r of liste ?? []) {
      if (r?.address && r.etn > 0) transfers.push({ day: e.day, to_address: r.address, etn: r.etn });
    }
  }
  transfers.sort((a, b) => b.etn - a.etn);
  const top = transfers.slice(0, 10);

  // Label und heutiger Bestand - in EINER Abfrage, nicht je Zeile eine.
  const adressen = [...new Set(top.map((r) => r.to_address))];
  const info = {};
  if (adressen.length) {
    const platz = adressen.map(() => "?").join(",");
    const zeilen = (
      await db
        .prepare(
          "SELECT a.hash, a.label, a.label_type, a.checksum_hash, c.etn, c.rank_pos" +
            " FROM addresses a LEFT JOIN current_balances c ON c.address = a.hash" +
            " WHERE a.hash IN (" + platz + ")"
        )
        .bind(...adressen)
        .all()
    ).results;
    for (const z of zeilen) info[z.hash] = z;
  }
  const schmuecke = (adr) => {
    const i = info[adr] ?? {};
    return {
      address: adr,
      checksum_hash: i.checksum_hash ?? null,
      label: i.label ?? null,
      label_type: i.label_type ?? null,
      bestand_jetzt: i.etn ?? null,
      rang_jetzt: i.rank_pos ?? null,
    };
  };

  // Wallets, die es vor dem Stichtag noch nicht gab. Vorher ist die Liste
  // leer - die Abfrage kostet dank Index trotzdem nichts.
  const neueSeit = vorbei ? stichtag + "T00:00:00Z" : null;
  let neue = null;
  if (neueSeit) {
    neue = await db
      .prepare(
        "SELECT COUNT(*) anzahl, SUM(c.etn) etn FROM addresses a" +
          " JOIN current_balances c ON c.address = a.hash" +
          " WHERE a.first_seen >= ? AND a.hash != ?"
      )
      // Ohne die Bridge. Sie ist keine zugezogene Wallet, und ihr Bestand ist
      // groesser als der aller anderen zusammen - im Probelauf machte sie aus
      // der Summe das Doppelte des tatsaechlichen Werts.
      .bind(neueSeit, String(env.BRIDGE_ADDRESS).toLowerCase())
      .first();
  }

  return {
    stichtag,
    vorbei,
    tage_bis: vorbei ? null : Math.max(0, tageBis),
    tage_seit: vorbei ? Math.round((jetzt - basis) / 86400000) : null,
    punkte,
    heute,
    verloren,
    endspurt,
    neue_wallets: neue,
    top_transfers: top.map((r) => ({
      ...schmuecke(r.to_address),
      tag: r.day,
      etn: r.etn,
    })),
    // Wie weit die Transfer-Historie reicht. Solange der Durchgang durch die
    // Bridge-Historie nicht fertig ist, sind "Top 10" die Top 10 des bisher
    // geprueften Fensters - und das gehoert dazugeschrieben, sonst liest sich
    // eine Teilmenge wie eine Bestenliste.
    // Wie weit die Auswertung reicht. Der Durchgang meldet es genauer; ohne
    // ihn bleibt der aelteste ausgewertete Tag die ehrlichste Angabe.
    transfers_ab:
      stand?.aeltestes_bekannt?.slice(0, 10) ??
      (ereignisse.results ?? []).reduce((m, e) => (m == null || e.day < m ? e.day : m), null),
    transfers_vollstaendig: !!stand?.fertig,
    mindestbetrag: BRIDGE_MIN_TRANSFER_ETN,
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
  const topN = zahlParam(u, "top", 12, 3, 20);

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
      // Auf 40 Zeichen: D1 lehnt laengere LIKE-Muster ab ("pattern too
      // complex") und antwortete darauf mit HTTP 500 statt "nichts gefunden" -
      // gemessen an der Live-Seite, schon bei 50 Zeichen. Das Kuerzen gehoert
      // genau hierhin und NICHT an den Aufruf: Eine vollstaendige Adresse hat
      // 42 Zeichen und wird oben abgefangen, bevor es zum LIKE kommt. Frueher
      // gekuerzt, waere sie 40 Zeichen lang gewesen und keine Adresse mehr.
      .bind("%" + q.slice(0, 40) + "%", "%" + q.slice(0, 40) + "%")
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
/**
 * Netzwerk-Kacheln.
 *
 * Kamen frueher bei jedem Cache-Miss direkt vom Explorer. Das sah harmlos aus
 * - zwei Anfragen je Minute -, war es aber nicht: Der Cloudflare-Cache liegt
 * JE RECHENZENTRUM getrennt. Bei Besuchern aus dreissig Laendern holen
 * dreissig Standorte ihre eigene Kopie, und die Last waere mit der
 * Besucherzahl mitgewachsen. Genau das soll die Seite dem Explorer von
 * Electroneum nicht antun.
 *
 * Der Snapshot-Lauf holt dieselben Zahlen ohnehin. Er legt sie jetzt mit ab,
 * hier werden sie nur gelesen: null Anfragen nach draussen, egal wie viele
 * Leute zuschauen. Preis dafuer sind Zahlen vom letzten Snapshot statt von
 * vor einer Minute - fuer Blockhoehe und Gaspreis verschmerzbar.
 */
async function network(db, env) {
  const kz = await kennzahlen(db);
  let s = kz?.netz?.stats ?? null;
  let verlauf = kz?.netz?.tx_chart ? { chart_data: kz.netz.tx_chart } : null;

  // Rueckfall, solange der Snapshot-Lauf die Zahlen noch nicht abgelegt hat
  // (frisch deployt, frische Datenbank).
  if (!s) {
    const api = env.EXPLORER_API;
    const holen = async (pfad) => {
      const r = await fetch(api + pfad, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(pfad + ": HTTP " + r.status);
      return r.json();
    };
    try {
      [s, verlauf] = await Promise.all([
        holen("/stats"),
        holen("/stats/charts/transactions").catch(() => null),
      ]);
    } catch (e) {
      return { leer: true, grund: e.message };
    }
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

/* ---------- Notlauf ----------------------------------------------------
 *
 * Faellt die Datenbank aus - gerissenes Tageslimit, Stoerung, was auch immer -,
 * lieferte die Seite bisher eine 500 und blieb leer. Von aussen sieht das aus
 * wie ein kaputtes Projekt, obwohl die Zahlen von vor zehn Minuten voellig
 * brauchbar gewesen waeren: sie aendern sich ohnehin nur alle 30 Minuten.
 *
 * Darum liegt von jeder geglueckten Antwort eine Zweitschrift im
 * Cloudflare-Cache. Scheitert die Datenbank, wird sie ausgeliefert, mit dem
 * Vermerk, von wann sie ist. Die Seite wird dann alt, aber sie steht.
 *
 * Best effort, keine Zusage: Der Cache gehoert Cloudflare, liegt je
 * Rechenzentrum getrennt und wird geraeumt, wann Cloudflare will. Ein
 * Standort, der noch nie eine gute Antwort gesehen hat, hat auch keine
 * Zweitschrift. Dafuer kostet er nichts und braucht keinen weiteren Dienst.
 */
const NOTLAUF_TAGE = 7;

/** Schluessel der Zweitschrift: dieselbe URL, aber ohne Cache-Buster - sonst
 *  legte jeder Aufruf mit ?_=<zeit> seine eigene an und faende nie eine. */
function notlaufSchluessel(u) {
  const k = new URL(u);
  k.searchParams.delete("_");
  k.pathname = "/__notlauf" + k.pathname;
  return new Request(k.toString());
}

async function notlaufSchreiben(cache, u, antwort) {
  const kopie = new Response(antwort.body, antwort);
  kopie.headers.set("cache-control", "public, max-age=" + NOTLAUF_TAGE * 86400);
  kopie.headers.set("x-notlauf-stand", new Date().toISOString());
  await cache.put(notlaufSchluessel(u), kopie);
}

/** Liefert die Zweitschrift, falls es eine gibt - sonst null. */
async function notlaufLesen(cache, u) {
  const alt = await cache.match(notlaufSchluessel(u));
  if (!alt) return null;
  let daten;
  try {
    daten = await alt.json();
  } catch {
    return null;
  }
  if (!daten || typeof daten !== "object" || Array.isArray(daten)) return null;
  return json(
    { ...daten, notlauf: true, notlauf_stand: alt.headers.get("x-notlauf-stand") },
    200,
    0
  );
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

    // Besuch melden: offen (jeder Besucher meldet seinen eigenen), Auswertung
    // nur fuer den Betreiber.
    if (pfad === "/api/besuch") {
      if (request.method !== "POST") return new Response("POST erforderlich", { status: 405 });
      return besuchMelden(request, env.DB);
    }
    if (pfad === "/api/besuche") {
      if (!adminOk(request, env)) {
        return json({ error: "Die Auswertung ist dem Betreiber vorbehalten." }, 403, 0);
      }
      return json(await besucheLesen(env.DB, u), 200, 0);
    }

    if (pfad === "/api/feedback") {
      if (request.method === "POST") return feedbackSenden(request, env.DB);
      if (!adminOk(request, env)) {
        return json({ error: "Der Posteingang ist dem Betreiber vorbehalten." }, 403, 0);
      }
      return json(await feedbackLesen(env.DB), 200, 0);
    }

    // Einzelnen Eintrag loeschen. Den Knopf im Browser zu verstecken reicht
    // nicht - loeschen kann sonst jeder, der die Adresse kennt. Also dieselbe
    // Pruefung wie beim Lesen des Posteingangs.
    const fbMatch = pfad.match(/^\/api\/feedback\/(\d+)$/);
    if (fbMatch) {
      if (request.method !== "DELETE") {
        return new Response("DELETE erforderlich", { status: 405 });
      }
      if (!adminOk(request, env)) {
        return json({ error: "Nur der Betreiber darf loeschen." }, 403, 0);
      }
      await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(Number(fbMatch[1])).run();
      return json({ ok: true }, 200, 0);
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
      else if (pfad === "/api/network") antwort = json(await network(db, env), 200, 120);
      else if (pfad === "/api/price") antwort = json(await preisverlauf(db, env, u), 200, 300);
      else if (pfad === "/api/clusters") antwort = json(await clusters_api(db));
      // Laenger gecacht als der Rest: die Bilanz besteht aus eingefrorenen
      // Werten und einer Wochen-Historie - nichts davon aendert sich in Minuten.
      else if (pfad === "/api/bilanz") antwort = json(await bilanz(db, env), 200, 600);
      else if (pfad === "/api/leaderboard") antwort = json(await leaderboard(db, env, u));
      else if (pfad === "/api/movers") antwort = json(await movers(db, env, u));
      else if (pfad === "/api/sleepers") antwort = json(await sleepers(db, env, u));
      else if (pfad === "/api/events") antwort = json(await events(db, u));
      else if (pfad === "/api/watchlist") antwort = json(await watchlist(db, env, u), 200, 30);
      else if (pfad === "/api/exchange-flow") antwort = json(await exchange_flow(db, u));
      else if (pfad === "/api/tiers") antwort = json({ tiers: TIERS });
      // Nur der Snapshot-Zeitstempel. Kurz gecacht, damit offene Seiten
      // haeufig nachfragen koennen, ohne die Datenbank zu belasten.
      else if (pfad === "/api/stand") antwort = json(await stand(db), 200, 20);
      else if (pfad === "/api/search") {
        const q = u.searchParams.get("q");
        antwort = q
          ? json(await suche(db, env, q.slice(0, 200)))
          : fehler("Parameter q fehlt");
      } else if (pfad.startsWith("/api/wallet-flows/")) {
        antwort = json(await wallet_flows(db, env, pfad.slice("/api/wallet-flows/".length), u));
      } else if (pfad.startsWith("/api/wallet/")) {
        const w = await wallet(db, env, pfad.slice("/api/wallet/".length));
        antwort = w ? json(w) : fehler("Wallet nicht gefunden", 404);
      } else antwort = fehler("Unbekannter Endpoint", 404);
    } catch (e) {
      // Lieber alte Zahlen mit Datum als eine leere Seite - siehe "Notlauf".
      const ersatz = await notlaufLesen(cache, u);
      if (ersatz) return ersatz;
      antwort = json(
        {
          error: e.message,
          stack: adminOk(request, env) ? String(e.stack).split("\n")[1] : undefined,
        },
        500,
        0
      );
    }

    if (antwort.status === 200) {
      ctx.waitUntil(cache.put(request, antwort.clone()));
      ctx.waitUntil(notlaufSchreiben(cache, u, antwort.clone()));
    }
    return antwort;
  },
};
