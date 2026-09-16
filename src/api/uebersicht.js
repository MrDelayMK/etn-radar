// Uebersicht: Kennzahlen, Netzwerk, Kursverlauf, Tier-Verlauf und der Snapshot-Stand.

import { TIERS, tierFor, tierMax, FAST_TIER_MIN } from "../tiers.js";
import { tagVor, kennzahlen } from "./grundlagen.js";

/**
 * Nur der Zeitstempel des letzten Snapshots - fuer das Nachladen im Browser.
 *
 * Absichtlich winzig: Eine offene Seite fragt hier jede Minute nach und laedt
 * erst dann wirklich neu, wenn sich der Wert geaendert hat. Wuerde sie
 * stattdessen im Takt alles neu ziehen, kostete jeder offene Tab zehn
 * Abfragen pro Minute.
 */
export async function stand(db) {
  const r = await db
    .prepare("SELECT id, taken_at FROM snapshots WHERE status='ok' ORDER BY id DESC LIMIT 1")
    .first();
  return { snapshot_id: r?.id ?? null, taken_at: r?.taken_at ?? null };
}

export async function overview(db, env) {
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

  // 7-Tage-Veraenderung je Stufe.
  //   Schnelle Stufen: heutiger Stand gegen den Tagesstand von vor sieben Tagen
  //   (tier_tage, beim ersten Snapshot des Tages geschrieben).
  //   Census-Stufen: neueste gegen die vorige Zaehlung - aber nur, wenn die
  //   fuenf bis neun Tage davor lag. Sonst waere es keine Woche, und eine Zahl
  //   ueber drei Wochen neben "7 days" waere schlicht falsch.
  const vergleichTier = await db
    .prepare(
      "SELECT tier, count, day FROM tier_tage" +
        " WHERE day = (SELECT max(day) FROM tier_tage WHERE day <= ?) AND day >= ?"
    )
    .bind(tagVor(7), tagVor(9))
    .all()
    .then((r) => Object.fromEntries(r.results.map((z) => [z.tier, z])))
    .catch(() => ({}));
  const vergleichCensus = censusTag
    ? await db
        .prepare(
          "SELECT tier, count, day FROM tier_census" +
            " WHERE day = (SELECT max(day) FROM tier_census WHERE day < ?)"
        )
        .bind(censusTag)
        .all()
        .then((r) =>
          Object.fromEntries(
            r.results
              .filter((z) => {
                const abstand = (Date.parse(censusTag) - Date.parse(z.day)) / 86400000;
                return abstand >= 5 && abstand <= 9;
              })
              .map((z) => [z.tier, z])
          )
        )
        .catch(() => ({}))
    : {};
  const aenderung = (jetzt, vorher) =>
    vorher?.count > 0 && jetzt != null
      ? {
          aenderung_7d: ((jetzt - vorher.count) / vorher.count) * 100,
          anzahl_vorher: vorher.count,
          vergleich_tag: vorher.day,
        }
      : {};

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

  // Wallets aus dem woechentlichen Census, die das Leaderboard zusaetzlich
  // listet. Aus der ersten und letzten Position statt COUNT(*): zwei
  // Indexzeilen statt 21.000 gelesener - bei jedem Seitenaufruf.
  const censusListe = await db
    .prepare(
      "SELECT (SELECT pos FROM census_wallets ORDER BY pos LIMIT 1) AS von," +
        " (SELECT pos FROM census_wallets ORDER BY pos DESC LIMIT 1) AS bis"
    )
    .first()
    .catch(() => null);

  return {
    snapshot: snap,
    census_wallets: censusListe?.von != null ? censusListe.bis - censusListe.von + 1 : 0,
    preis: snap.etn_price,
    telegram_bot: env.TELEGRAM_BOT_USERNAME ?? null,
    // Optional wie der Telegram-Bot: ohne Variable bleibt der Spendenknopf
    // unsichtbar. Geprueft, damit ein Tippfehler in der Konfiguration nie als
    // Adresse erscheint, an die jemand tatsaechlich Geld schickt.
    spenden_adresse: /^0x[0-9a-fA-F]{40}$/.test(String(env.DONATE_ADDRESS ?? ""))
      ? env.DONATE_ADDRESS
      : null,
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
          ...aenderung(c?.count ?? null, vergleichCensus[t.key]),
        };
      }
      return {
        ...t,
        max: tierMax(t.key),
        anzahl: proTier["n_" + t.key] ?? 0,
        etn: proTier["e_" + t.key] ?? 0,
        geschaetzt: false,
        ...aenderung(proTier["n_" + t.key] ?? 0, vergleichTier[t.key]),
      };
    }),
    verlauf: reihe,
    bridge_verlauf: bReihe,
  };
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

export async function preisverlauf(db, env, u) {
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
          // Auf taken_at selbst gefiltert statt auf substr(...): nur so greift
          // der Index der Spalte. Mit substr lief die Abfrage bei jedem Aufruf
          // durch ALLE Snapshots, und es kommen 48 am Tag dazu. Fuer
          // ISO-Zeitstempel ist beides gleichbedeutend - "2026-08-11T07:37"
          // ist groesser als "2026-08-11", "2026-08-10T23:37" nicht.
          "    FROM snapshots WHERE etn_price IS NOT NULL AND taken_at >= ?1" +
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

/* ---------- Bridge-Bestand seit dem Start ---------------------------------
 *
 * Aus den Tagessummen des Bridge-Durchgangs (bridge_tage) rueckwaerts
 * gerechnet, ausgehend vom Bestand zu Beginn seines letzten Laufs: der Bestand
 * am Ende eines Tages ist der Bestand am Ende des naechsten Tages plus das, was
 * an jenem naechsten Tag abgeflossen ist.
 *
 * Nur wenn der Durchgang die Historie bis zum Anfang gelesen hat. Eine halbe
 * Historie saehe im Chart aus wie eine ganze - bis dahin bleibt die Seite bei
 * den 120 Tagen aus der Uebersicht.
 */
/**
 * Wallets je schneller Stufe ueber die Zeit - fuer die kleinen Verlaufs-Charts
 * unter den Tier-Zeilen. Ein Punkt je Tag, hoechstens ein Jahr.
 *
 * Beginnt am 02.09.2026: eigene Snapshots gibt es seit dem 06.09., die Tage
 * davor sind aus daily_balances nachgerechnet. Weiter zurueck waere es
 * geschoent - die aelteren Tagesbestaende kennen nur Wallets, die heute noch
 * gross sind, und taeuschten so Wachstum vor.
 */
export async function tierVerlauf(db) {
  const zeilen = await db
    .prepare("SELECT day, tier, count FROM tier_tage WHERE day >= ? ORDER BY day")
    .bind(tagVor(365))
    .all()
    .then((r) => r.results ?? [])
    .catch(() => []);
  const tage = new Map();
  for (const z of zeilen) {
    if (!tage.has(z.day)) tage.set(z.day, { day: z.day });
    tage.get(z.day)[z.tier] = z.count;
  }
  return { tage: [...tage.values()] };
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
export async function network(db, env) {
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
