// Wallets: Leaderboard, Movers, Sleepers, Ereignisse, Watchlist, Profil, Suche,
// Money Flow, Boersen-Fluss und Cluster.

import { TIERS, tierProgress, tierFor, tierMax } from "../tiers.js";
import { clusterGruppen } from "../clusters.js";
import { fetchAddress, fetchBalanceChanges } from "../blockscout.js";
import { liveBestand, liveBudget, liveBudgetKorrigieren } from "./live.js";
import { fehler, zahlParam, tagVor, ZEITRAUM, STD_ZEITRAUM, WALLET_FELDER, schmuecken, kennzahlen } from "./grundlagen.js";

/*
 * Das Leaderboard zeigt drei Zeitraeume nebeneinander statt einen per Tab.
 * Worum es in der Tabelle geht - welche grossen Wallets sich zuletzt bewegt
 * haben -, sieht man so auf einen Blick, ohne erst umzuschalten.
 *
 * Die Vergangenheit wird nur fuer die Zeilen der angezeigten Seite
 * nachgeschlagen: fuenf kleine Indexzugriffe je Zeile.
 */
const LB_SPALTEN = [["d24h", 1], ["d7d", 7], ["d6m", 182]];
const LB_VERGANGENHEIT =
  LB_SPALTEN.map(([k]) =>
    ", (SELECT d.etn FROM daily_balances d WHERE d.address = c.address AND d.day <= ?" +
    "   ORDER BY d.day DESC LIMIT 1) AS vorher_" + k
  ).join("") +
  ", (SELECT d.etn FROM daily_balances d WHERE d.address = c.address" +
  "   ORDER BY d.day ASC LIMIT 1) AS etn_erster" +
  ", (SELECT d.day FROM daily_balances d WHERE d.address = c.address" +
  "   ORDER BY d.day ASC LIMIT 1) AS tag_erster";
const lbStichtage = () => LB_SPALTEN.map(([, tage]) => tagVor(tage));

function lbZeile(r, platz, jetzt) {
  const z = { ...schmuecken(r, jetzt), platz };
  for (const [k, tage] of LB_SPALTEN) {
    z[k] = delta({ ...r, etn_vorher: r["vorher_" + k] }, tage, jetzt);
    delete z["vorher_" + k];
  }
  return z;
}

/*
 * Rangliste - fuer alle Filter derselbe Weg ueber den Index auf etn.
 *
 * Gelesen wird nur die angezeigte Seite. Den Rang muss keine Abfrage ueber
 * alle Wallets berechnen: Tier und Balance-Bereich schneiden einen
 * zusammenhaengenden Ausschnitt aus der Rangliste heraus, dessen erste Wallet
 * auf Platz "Wallets darueber + 1" steht - eine Zaehlung ueber denselben Index.
 * "Real wallets only" und "Services only" gehen ueber den Teilindex
 * idx_addresses_markiert, der nur die rund zwanzig markierten Adressen haelt.
 *
 * Bis 11.09.2026 rechnete eine Fensterfunktion den Rang ueber alle 3.000
 * Wallets: "Real wallets only" las so rund 36.000 Zeilen je Aufruf. Wer das
 * gezielt wiederholte, konnte das Tageskontingent von D1 leerlesen. Den
 * gespeicherten rank_pos zu nehmen ging nicht - er kommt vom Explorer und
 * weicht bei fast allen Wallets um bis zu vier Plaetze von dieser Reihenfolge ab.
 */
// Die Bedingung des Teilindex - woertlich so, sonst benutzt SQLite ihn nicht.
const MARKIERT = "(label_type IS NOT NULL OR is_excluded = 1 OR is_contract = 1)";
// Was "Real wallets only" ausblendet: Boersen, Bridges, Dienste, Contracts und
// ausdruecklich Ausgeschlossene - eine Teilmenge der markierten Adressen.
const NICHT_ECHT_SQL =
  "SELECT hash FROM addresses WHERE " + MARKIERT +
  " AND (is_excluded = 1 OR label_type IN ('exchange','bridge','service') OR is_contract = 1)";
const DIENSTE_SQL = "SELECT hash FROM addresses WHERE " + MARKIERT;

// Die Gesamtzahl ohne Filter steht im vorberechneten Kennzahlen-Block. Die
// Zaehlung selbst las bei jedem Aufruf alle rund 3.000 Zeilen - fuer eine
// einzige Zahl, die sich nur mit dem Snapshot aendert.
const kennzahlGesamt = (db, bridge) =>
  kennzahlen(db).then((kz) =>
    kz?.holder_anzahl != null
      ? { n: kz.holder_anzahl }
      : db
          .prepare("SELECT COUNT(*) n FROM current_balances WHERE in_top_n = 1 AND address != ?")
          .bind(bridge)
          .first()
  );

export async function leaderboard(db, env, u) {
  const limit = zahlParam(u, "limit", 50, 10, 250);
  const offset = zahlParam(u, "offset", 0, 0, 100000);
  const bridge = String(env.BRIDGE_ADDRESS).toLowerCase();
  const tier = TIERS.find((t) => t.key === u.searchParams.get("tier")) ?? null;
  // "Nur echte Wallets": Bridge, Boersen UND Contracts raus. Uebrig bleibt,
  // was tatsaechlich einer Person oder Gruppe gehoert.
  const nurEcht = u.searchParams.get("nur_wallets") === "1";
  // Das genaue Gegenteil davon: Boersen, Bridges, Dienste und Contracts.
  const nurDienste = !nurEcht && u.searchParams.get("nur_dienste") === "1";
  // Balance-Bereich, z.B. "zeig mir nur 100k-500k ETN".
  const minEtn = u.searchParams.has("min_etn") ? zahlParam(u, "min_etn", null) : null;
  const maxEtn = u.searchParams.has("max_etn") ? zahlParam(u, "max_etn", null) : null;

  // BASIS: wer ueberhaupt mitzaehlt - dort beginnt der Rang bei 1.
  // BEREICH: der Ausschnitt daraus, der Rang laeuft weiter.
  const basis =
    " WHERE c.in_top_n = 1 AND c.address != ?" +
    (nurEcht ? " AND c.address NOT IN (" + NICHT_ECHT_SQL + ")" : "") +
    (nurDienste ? " AND c.address IN (" + DIENSTE_SQL + ")" : "");
  const bereich =
    (tier ? " AND c.tier = ?" : "") +
    (minEtn != null ? " AND c.etn >= ?" : "") +
    (maxEtn != null ? " AND c.etn <= ?" : "");
  const bereichArgs = [tier?.key, minEtn, maxEtn].filter((v) => v != null);

  const zaehlen = (bedingung, args) =>
    db
      .prepare("SELECT COUNT(*) n FROM current_balances c" + basis + bedingung)
      .bind(bridge, ...args)
      .first();

  // Wer steht ueber dem Ausschnitt? Die engere der beiden Obergrenzen:
  // Balance (etn <= max) oder Tier (etn unter der Untergrenze der naechsten Stufe).
  const tierDecke = tier ? tierMax(tier.key) : null;
  let darueber = null;
  if (tierDecke != null && (maxEtn == null || tierDecke <= maxEtn)) darueber = [" AND c.etn >= ?", tierDecke];
  else if (maxEtn != null) darueber = [" AND c.etn > ?", maxEtn];

  // Alle der Basis - ohne Durchlauf durch die Liste, wo es geht.
  const basisAbfrage = nurEcht
    ? Promise.all([
        kennzahlGesamt(db, bridge),
        db
          .prepare(
            "SELECT COUNT(*) n FROM current_balances c WHERE c.in_top_n = 1 AND c.address != ?" +
              " AND c.address IN (" + NICHT_ECHT_SQL + ")"
          )
          .bind(bridge)
          .first(),
      ]).then(([alle, weg]) => ({ n: (alle?.n ?? 0) - (weg?.n ?? 0) }))
    : nurDienste
      ? zaehlen("", [])
      : kennzahlGesamt(db, bridge);
  const gesamtAbfrage = bereich ? zaehlen(bereich, bereichArgs) : basisAbfrage;

  const [gesamt, basisGesamt, ueber] = await Promise.all([
    gesamtAbfrage,
    bereich ? basisAbfrage : gesamtAbfrage,
    darueber ? zaehlen(darueber[0], [darueber[1]]) : null,
  ]);
  const n1 = gesamt?.n ?? 0;

  // Erst die Top N, dann - wenn die Seite dort nicht voll wird - die Wallets
  // aus dem woechentlichen Census (censusTeil).
  const res =
    offset < n1
      ? await db
          .prepare(
            "SELECT " + WALLET_FELDER + LB_VERGANGENHEIT +
              " FROM current_balances c LEFT JOIN addresses a ON a.hash = c.address" +
              basis + bereich +
              " ORDER BY c.etn DESC LIMIT ? OFFSET ?"
          )
          .bind(...lbStichtage(), bridge, ...bereichArgs, limit, offset)
          .all()
      : { results: [] };

  const jetzt = Date.now();
  const vorher = ueber?.n ?? 0;
  const eintraege = res.results.map((r, i) => lbZeile(r, vorher + offset + i + 1, jetzt));

  const census = await censusTeil(db, {
    nurEcht, nurDienste,
    von: Math.min(maxEtn ?? Infinity, tierDecke ?? Infinity),
    vonInklusiv: maxEtn != null && (tierDecke == null || maxEtn < tierDecke),
    bis: Math.max(minEtn ?? 0, tier?.min ?? 0),
    offset: Math.max(0, offset - n1),
    limit: limit - eintraege.length,
    platzAb: basisGesamt?.n ?? 0,
  }).catch(() => null);

  if (census) {
    for (const r of census.zeilen) {
      const stand = [census.stand, r.gesehen, r.aktualisiert].filter(Boolean).sort().pop() ?? null;
      eintraege.push({ ...lbZeile(r, r.platz, jetzt), census: 1, stand });
    }
  }

  return {
    gesamt: n1 + (census?.anzahl ?? 0),
    offset,
    limit,
    census_stand: census?.stand ?? null,
    // Ab diesem Index (0-basiert, im gefilterten Ergebnis) kommen die Census-Zeilen.
    census_ab: census?.anzahl ? n1 : null,
    eintraege,
  };
}

/*
 * Leaderboard nach den Top N: die Wallets aus dem woechentlichen Census
 * (census_wallets). Blaettern und Filter gehen ueber die gespeicherte
 * Position statt ueber OFFSET - eine Seite liest so nur ihre eigenen Zeilen,
 * auch ganz hinten in der Liste. Die Stellen der Bestandsgrenzen hat der
 * Census in census_grenzen abgelegt.
 *
 * Die Zeilen stehen in der Reihenfolge des Census. Wer seither live
 * aufgefrischt wurde, behaelt seinen Platz, zeigt aber den neuen Bestand.
 */
const CW_FELDER =
  "w.address, w.rank_pos, w.balance_wei, w.etn, NULL AS tier, w.tx_count, NULL AS updated_at, 0 AS in_top_n," +
  " a.checksum_hash, a.label, a.label_type, a.label_source," +
  " COALESCE(a.ens_name, CASE WHEN w.is_contract = 0 THEN w.name END) AS ens_name," +
  " COALESCE(a.contract_name, CASE WHEN w.is_contract = 1 THEN w.name END) AS contract_name," +
  " a.impl_name, COALESCE(a.is_contract, w.is_contract) AS is_contract, a.exchange_score, a.is_excluded," +
  " w.pos, w.gesehen, w.aktualisiert," +
  " NULL AS vorher_d24h, w.etn_vorher AS vorher_d7d, NULL AS vorher_d6m, NULL AS etn_erster, NULL AS tag_erster";
const CW_VON = " FROM census_wallets w LEFT JOIN addresses a ON a.hash = w.address";

async function censusTeil(db, o) {
  const erste = await db.prepare("SELECT pos FROM census_wallets ORDER BY pos LIMIT 1").first();
  if (!erste) return null;
  const letzte = await db.prepare("SELECT pos FROM census_wallets ORDER BY pos DESC LIMIT 1").first();
  const lauf = await db
    .prepare("SELECT taken_at FROM census_runs WHERE status = 'ok' ORDER BY taken_at DESC LIMIT 1")
    .first()
    .catch(() => null);

  // Position, ab der der Bestand unter (bzw. bis) `wert` liegt.
  const grenzPos = async (wert, inklusiv) => {
    if (wert === Infinity) return erste.pos;
    if (wert <= 0) return letzte.pos + 1;
    const g = await db.prepare("SELECT pos_unter, pos_bis FROM census_grenzen WHERE grenze = ?").bind(wert).first();
    let p;
    if (g) {
      p = inklusiv ? g.pos_bis : g.pos_unter;
    } else {
      // Unbekannter Wert: binaere Suche ueber den Positionsindex, ~15 Zeilen.
      let lo = Math.max(1, erste.pos), hi = letzte.pos + 1;
      while (lo < hi) {
        const mitte = Math.floor((lo + hi) / 2);
        const z = await db
          .prepare("SELECT pos, etn FROM census_wallets WHERE pos >= ? ORDER BY pos LIMIT 1")
          .bind(mitte)
          .first();
        if (!z) { hi = mitte; continue; }
        if (inklusiv ? z.etn <= wert : z.etn < wert) hi = mitte;
        else lo = z.pos + 1;
      }
      p = lo;
    }
    if (p <= 1 && erste.pos < 1) {
      // Aus den Top N gefallene Wallets stehen vor Position 1 und kommen in
      // keiner gespeicherten Grenze vor - es sind wenige, direkt nachsehen.
      const m = await db
        .prepare("SELECT MIN(pos) AS m FROM census_wallets WHERE pos < 1 AND etn " + (inklusiv ? "<=" : "<") + " ?")
        .bind(wert)
        .first();
      return m?.m ?? 1;
    }
    return p;
  };

  const start = await grenzPos(o.von, o.vonInklusiv);
  const ende = await grenzPos(o.bis, false); // exklusiv
  const stand = lauf?.taken_at ?? null;
  const platz = (pos) => o.platzAb + (pos - erste.pos) + 1;
  const leer = { zeilen: [], anzahl: 0, stand };
  if (ende <= start) return leer;

  // Dienste unter den Census-Wallets: Contracts (Teilindex) und markierte
  // Adressen (die rund zwanzig aus addresses, von dort aus gesucht). Ein OR
  // in einer Abfrage liesse SQLite den ganzen Positionsbereich lesen.
  const DIENST_TEILE = [
    "SELECT " + CW_FELDER + " FROM census_wallets w INDEXED BY idx_census_wallets_contract" +
      " LEFT JOIN addresses a ON a.hash = w.address" +
      " WHERE w.is_contract = 1 AND w.pos >= ? AND w.pos < ?",
    "SELECT " + CW_FELDER + " FROM (" + DIENSTE_SQL + ") d CROSS JOIN census_wallets w ON w.address = d.hash" +
      " LEFT JOIN addresses a ON a.hash = w.address" +
      " WHERE w.is_contract = 0 AND w.pos >= ? AND w.pos < ?",
  ];
  const dienstZahl = () =>
    Promise.all(
      DIENST_TEILE.map((sql) =>
        db.prepare("SELECT COUNT(*) n FROM (" + sql + ")").bind(start, ende).first()
      )
    ).then((r) => r.reduce((s, x) => s + (x?.n ?? 0), 0));

  if (o.nurDienste) {
    const [n, zeilen] = await Promise.all([
      dienstZahl(),
      o.limit > 0
        ? db
            .prepare(DIENST_TEILE.join(" UNION ALL ") + " ORDER BY pos LIMIT ? OFFSET ?")
            .bind(start, ende, start, ende, o.limit, o.offset)
            .all()
        : { results: [] },
    ]);
    return { zeilen: zeilen.results.map((r) => ({ ...r, platz: platz(r.pos) })), anzahl: n, stand };
  }

  let anzahl = ende - start;
  if (o.nurEcht) anzahl -= await dienstZahl();
  if (o.limit <= 0) return { zeilen: [], anzahl, stand };

  // Seite als Positionsbereich: eine Luecke (aufgestiegenes Wallet) macht die
  // Seite hoechstens eine Zeile kuerzer, verschiebt aber nichts.
  const ab = start + o.offset;
  const bisPos = Math.min(ende, ab + o.limit);
  if (ab >= ende) return { zeilen: [], anzahl, stand };
  const zeilen = await db
    .prepare(
      "SELECT " + CW_FELDER + CW_VON + " WHERE w.pos >= ? AND w.pos < ?" +
        (o.nurEcht ? " AND w.is_contract = 0 AND w.address NOT IN (" + NICHT_ECHT_SQL + ")" : "") +
        " ORDER BY w.pos"
    )
    .bind(ab, bisPos)
    .all();
  return { zeilen: zeilen.results.map((r) => ({ ...r, platz: platz(r.pos) })), anzahl, stand };
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

export async function movers(db, env, u) {
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

export async function sleepers(db, env, u) {
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
export async function watchlist(db, env, u) {
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

export async function events(db, u) {
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

export async function wallet(db, env, hash) {
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

/**
 * Cluster-Vermutungen: Wallets mit gemeinsamer Finanzierungsquelle.
 *
 * WICHTIG: kein Beweis, keine Identitaet - nur ein Muster (siehe die
 * ausfuehrliche Erklaerung in src/clusters.js und der README). Der Endpunkt
 * gibt deshalb immer einen Hinweistext mit, den die Oberflaeche sichtbar
 * neben jedem Ergebnis zeigen soll.
 */
export async function clusters_api(db) {
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
export async function exchange_flow(db, u) {
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

  // Feste Tage statt Zeitraum fuer den Wochenrueckblick (src/api/chain.js):
  // dieselben sieben abgeschlossenen Tage wie der Rest der Woche.
  const abTag = u.searchParams.get("from") ?? tagVor(tage);
  const bisTag = u.searchParams.get("to") ?? "9999";
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
    if (delta === 0n || r.day < abTag || r.day > bisTag) continue;

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
export async function wallet_flows(db, env, adresse, u) {
  const adr = adresse.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(adr)) return fehler("Keine gueltige Adresse");

  const zeitraum = u.searchParams.get("period") ?? "7d";
  const tage = ZEITRAUM[zeitraum] ?? 7;
  const abZeit = new Date(Date.now() - tage * 86400000).toISOString();
  const topN = zahlParam(u, "top", 12, 3, 20);

  // Bis zu zehn Seiten je Richtung: vorab das Maximum aus dem Minutenbudget
  // reservieren, danach auf die tatsaechlich gelesenen Seiten korrigieren.
  const buchung = await liveBudget(db, "fluss", 20);
  if (!buchung) return { beschaeftigt: true };
  const { fetchInboundTransactions, fetchOutboundTransactions } = await import("../blockscout.js");
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
    let aeltestes = null;
    for (const t of res.transfers) {
      if (t.timestamp < abZeit) continue;      // ausserhalb des Fensters
      if (!aeltestes || t.timestamp < aeltestes) aeltestes = t.timestamp;
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
      // Ab wann der Fluss dann wirklich zaehlt - der aelteste gelesene Transfer.
      ab: !res.vollstaendig ? aeltestes : null,
    };
  }

  const inflow = buendeln(rein);
  const outflow = buendeln(raus);
  await liveBudgetKorrigieren(db, buchung, (rein.seiten ?? 10) + (raus.seiten ?? 10));

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
export async function suche(db, env, q) {
  const adr = q.trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(adr)) {
    const lokal = await wallet(db, env, adr);
    if (lokal) return { quelle: "db", ...lokal };
    // Unterhalb der Top N: vielleicht aus dem woechentlichen Census bekannt.
    const census = await censusWallet(db, adr);
    // Live beim Explorer holen, damit jedes Wallet seinen Tier sehen kann.
    // Eine Anfrage beim Explorer - aus dem gemeinsamen Minutenbudget. Ist es
    // aufgebraucht, reicht fuer Census-Wallets der Wochenstand (mit Datum
    // und Refresh-Knopf auf der Seite).
    if (!(await liveBudget(db, "suche", 1))) {
      return census ? walletOhneVerlauf(census, "census", census.stand) : { beschaeftigt: true };
    }
    const live = await fetchAddress(env.EXPLORER_API, adr);
    const zeit = new Date().toISOString();
    if (census) await censusAuffrischen(db, adr, live, zeit);
    await db
      .prepare("INSERT INTO live_abrufe (address, geholt_am) VALUES (?,?) ON CONFLICT(address) DO UPDATE SET geholt_am = excluded.geholt_am")
      .bind(adr, zeit)
      .run()
      .catch(() => {});
    return walletOhneVerlauf(
      { ...census, address: adr, etn: live.etn, balance_wei: live.balance_wei },
      census ? "census_live" : "explorer",
      zeit
    );
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

// Ein Wallet ausserhalb der Top N: Tier und Fortschritt aus dem Bestand, ohne
// Verlauf, Ereignisse und Cluster - die gibt es nur fuer die Top N.
function walletOhneVerlauf(w, quelle, stand) {
  const p = tierProgress(w.etn);
  return {
    quelle,
    stand,
    address: w.address,
    etn: w.etn,
    balance_wei: w.balance_wei,
    tier: p.tier.key,
    tier_name: p.tier.name,
    tier_emoji: p.tier.emoji,
    tier_progress: p.progress,
    bis_naechster_tier: p.isTop ? null : p.needed,
    naechster_tier: p.next?.name ?? null,
    in_top_n: 0,
    // Platz beim letzten Census - ungefaehr, weil sich seither alles bewegt haben kann.
    census_rang: w.rank_pos ?? null,
    anzeige: w.name ?? null,
  };
}

async function censusWallet(db, adr) {
  const w = await db
    .prepare(
      "SELECT address, rank_pos, balance_wei, etn, name, gesehen, aktualisiert," +
        " (SELECT taken_at FROM census_runs WHERE status = 'ok' ORDER BY taken_at DESC LIMIT 1) AS lauf" +
        " FROM census_wallets WHERE address = ?"
    )
    .bind(adr)
    .first()
    .catch(() => null);
  if (!w) return null;
  return { ...w, stand: [w.lauf, w.gesehen, w.aktualisiert].filter(Boolean).sort().pop() };
}

async function censusAuffrischen(db, adr, live, zeit) {
  if (live?.balance_wei == null) return;
  await db
    .prepare("UPDATE census_wallets SET balance_wei = ?, etn = ?, aktualisiert = ? WHERE address = ?")
    .bind(String(live.balance_wei), live.etn, zeit, adr)
    .run()
    .catch(() => {});
}

/*
 * "Refresh" auf der Wallet-Seite: den Bestand eines Wallets ausserhalb der
 * Top N jetzt live holen. Zwei Bremsen, damit niemand darueber den Explorer
 * zuschuettet:
 *
 *   je Wallet   hoechstens alle REFRESH_SPERRE_MS (live_abrufe)
 *   global      das gemeinsame Minutenbudget der Besucher-Abrufe (liveBudget)
 *
 * Die Top N brauchen das nicht - die frischt schon das Oeffnen der Seite auf.
 */
const REFRESH_SPERRE_MS = 10 * 60000;

export async function walletRefresh(db, env, hash) {
  const adr = String(hash ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(adr)) return { status: 400, daten: { error: "Keine gueltige Adresse" } };
  const jetzt = Date.now();
  const letzte = await db
    .prepare("SELECT geholt_am FROM live_abrufe WHERE address = ?")
    .bind(adr)
    .first()
    .catch(() => null);
  if (letzte && jetzt - Date.parse(letzte.geholt_am) < REFRESH_SPERRE_MS) {
    const warten = Math.ceil((REFRESH_SPERRE_MS - (jetzt - Date.parse(letzte.geholt_am))) / 1000);
    return { status: 429, daten: { error: "Refreshed just now - try again later.", warten_s: warten } };
  }
  if (!(await liveBudget(db, "refresh", 1))) {
    return { status: 429, daten: { error: "The explorer is busy right now - try again in a minute.", warten_s: 60 } };
  }
  const live = await fetchAddress(env.EXPLORER_API, adr);
  const zeit = new Date(jetzt).toISOString();
  await db
    .prepare(
      "INSERT INTO live_abrufe (address, geholt_am) VALUES (?,?)" +
        " ON CONFLICT(address) DO UPDATE SET geholt_am = excluded.geholt_am"
    )
    .bind(adr, zeit)
    .run();
  const census = await censusWallet(db, adr);
  if (census) await censusAuffrischen(db, adr, live, zeit);
  return {
    status: 200,
    daten: walletOhneVerlauf(
      { ...census, address: adr, etn: live.etn, balance_wei: live.balance_wei },
      census ? "census_live" : "explorer",
      zeit
    ),
  };
}

/*
 * Verlauf fuer Wallets ausserhalb der Top N. Die Top N schreibt der Snapshot
 * ohnehin Tag fuer Tag mit; alle anderen kosten je eine Explorer-Anfrage. Die
 * laeuft darum erst, wenn jemand das Wallet oeffnet, und hoechstens alle
 * VERLAUF_SPERRE_MS je Wallet - dazwischen kommt alles aus daily_balances.
 *
 * Geholt wird eine Seite der Einzelaenderungen (50 Stueck). Bei ruhigen
 * Wallets ist das die ganze Vergangenheit; bei aktiven die juengste Zeit, und
 * spaetere Abrufe setzen oben an, was seither dazukam.
 */
const VERLAUF_SPERRE_MS = 12 * 3600000;
const AENDERUNGEN_JE_SEITE = 50;

export async function walletVerlauf(db, env, hash, jetzt = Date.now()) {
  const adr = String(hash ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(adr)) return fehler("Keine gueltige Adresse", 400);
  const [stand, bekannt] = await Promise.all([
    db.prepare("SELECT geholt_am, vollstaendig FROM verlauf_abrufe WHERE address = ?").bind(adr).first().catch(() => null),
    db.prepare("SELECT in_top_n FROM current_balances WHERE address = ?").bind(adr).first().catch(() => null),
  ]);
  const lesen = async () =>
    (await db.prepare("SELECT day, etn FROM daily_balances WHERE address = ? ORDER BY day").bind(adr).all()).results ?? [];
  // Aus den Top N gefallene Wallets haben ihre Vergangenheit schon vom Backfill.
  let vollstaendig = !!stand?.vollstaendig || !!bekannt;
  if (bekannt?.in_top_n === 1) return { verlauf: await lesen(), vollstaendig: true };

  let beschaeftigt = false;
  if (!stand || jetzt - Date.parse(stand.geholt_am) >= VERLAUF_SPERRE_MS) {
    if (await liveBudget(db, "verlauf", 1)) {
      const aenderungen = await fetchBalanceChanges(env.EXPLORER_API, adr, { maxPages: 1 });
      // Neueste zuerst: die erste Aenderung eines Tages ist sein Schlussstand.
      const tage = new Map();
      for (const a of aenderungen) {
        const tag = a.at.slice(0, 10);
        if (!tage.has(tag)) tage.set(tag, a.balance_wei);
      }
      vollstaendig ||= aenderungen.length < AENDERUNGEN_JE_SEITE;
      const zeilen = [...tage].map(([tag, wei]) =>
        db
          .prepare(
            "INSERT INTO daily_balances (address, day, balance_wei, etn, source) VALUES (?,?,?,?,'besuch')" +
              // Snapshot und Backfill sind genauer - die bleiben stehen.
              " ON CONFLICT(address, day) DO UPDATE SET balance_wei = excluded.balance_wei, etn = excluded.etn" +
              " WHERE daily_balances.source = 'besuch'"
          )
          .bind(adr, tag, wei, Number(BigInt(wei) / 10n ** 12n) / 1e6)
      );
      zeilen.push(
        db
          .prepare(
            "INSERT INTO verlauf_abrufe (address, geholt_am, vollstaendig) VALUES (?,?,?)" +
              " ON CONFLICT(address) DO UPDATE SET geholt_am = excluded.geholt_am," +
              " vollstaendig = max(verlauf_abrufe.vollstaendig, excluded.vollstaendig)"
          )
          .bind(adr, new Date(jetzt).toISOString(), vollstaendig ? 1 : 0)
      );
      await db.batch(zeilen);
    } else {
      beschaeftigt = true;
    }
  }
  const verlauf = await lesen();
  // Budget aufgebraucht und noch nichts gespeichert: "gleich nochmal" statt leerer Kurve.
  if (beschaeftigt && !verlauf.length) return { beschaeftigt: true };
  return { verlauf, vollstaendig };
}

/*
 * Wal-Alarm fuer das Popup beim Seitenbesuch: die grossen Bewegungen der
 * letzten sieben Tage. Fuer alle Besucher dieselbe Antwort (zwischengespeichert);
 * welche davon seit dem letzten Besuch neu sind, entscheidet der Browser.
 * Die Bridge selbst fehlt - ihr taeglicher Abfluss ist die Migration, kein Wal.
 */
const WAL_MIN_ETN = 10e6;
const WECKER_MIN_ETN = 1e6;

export async function wale(db, env) {
  const bridge = String(env.BRIDGE_ADDRESS ?? "").toLowerCase();
  const rows = (
    await db
      .prepare(
        "SELECT e.*, a.label, a.label_type, a.ens_name, c.etn FROM events e" +
          " LEFT JOIN addresses a ON a.hash = e.address" +
          " LEFT JOIN current_balances c ON c.address = e.address" +
          " WHERE e.detected_at >= ? AND e.address != ?" +
          " AND ((e.type IN ('gain','loss','drained') AND abs(coalesce(e.delta_etn, 0)) >= ?)" +
          "      OR (e.type = 'sleeper_wake' AND abs(coalesce(e.delta_etn, 0)) >= ?))" +
          " ORDER BY e.detected_at DESC LIMIT 80"
      )
      .bind(tagVor(7) + "T00:00:00Z", bridge, WAL_MIN_ETN, WECKER_MIN_ETN)
      .all()
  ).results;
  return {
    eintraege: buendeln(rows)
      .slice(0, 20)
      .map((r) => ({
        address: r.address,
        type: r.type,
        auch: r.auch ?? [],
        delta_etn: r.delta_etn,
        detected_at: r.detected_at,
        anzeige: r.label ?? r.ens_name ?? null,
        label_type: r.label_type ?? null,
        tier_emoji: r.etn != null ? tierFor(r.etn).emoji : null,
      })),
  };
}
