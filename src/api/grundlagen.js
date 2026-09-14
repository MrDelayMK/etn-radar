// Gemeinsame Bausteine der API: Antworten, Parameter, Datumshilfen, Wallet-Felder,
// Admin-Pruefung und der Zwischenspeicher samt Notlauf.

import { tierProgress } from "../tiers.js";

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

export const json = (data, status = 200, cache = CACHE_SEKUNDEN) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${cache}`,
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });

export const fehler = (msg, status = 400) => json({ error: msg }, status, 0);

/**
 * Zahl aus einem Abfrageparameter - mit Rueckfall und Grenzen.
 *
 * Number("abc") ist NaN, und NaN geht durch Math.min/Math.max unveraendert
 * hindurch: aus Math.min(200, Math.max(10, NaN)) wird wieder NaN. Genau so
 * landete "?limit=abc" als Bindungswert in der Abfrage und quittierte mit 500.
 * Einmal hier abgefangen statt an zehn Aufrufstellen.
 */
export function zahlParam(u, name, standard, min = -Infinity, max = Infinity) {
  const roh = u.searchParams.get(name);
  const n = roh == null || roh === "" ? standard : Number(roh);
  if (!Number.isFinite(n)) return standard;
  return Math.min(max, Math.max(min, n));
}

/** Tag N Tage in der Vergangenheit als YYYY-MM-DD. */
export const tagVor = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// Auswertbare Zeitraeume. 6m/1y funktionieren, weil der Backfill ueber
// coin-balance-history Stuetzpunkte bis zurueck zur Entstehung des Wallets
// holt - nicht nur die 90 Tage des by-day-Endpoints.
export const ZEITRAUM = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "6m": 182, "1y": 365 };
export const STD_ZEITRAUM = "7d";

// Anreicherung, die mehrere Endpoints teilen.
export const WALLET_FELDER =
  "c.address, c.rank_pos, c.balance_wei, c.etn, c.tier, c.tx_count, c.updated_at, c.in_top_n," +
  " a.checksum_hash, a.label, a.label_type, a.label_source, a.ens_name, a.contract_name," +
  " a.impl_name, a.is_contract, a.exchange_score, a.is_excluded";

/** Ergaenzt Anzeigename, Tier-Fortschritt und Ruhedauer. */
export function schmuecken(r, jetzt = Date.now()) {
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
export async function kennzahlen(db) {
  try {
    const row = await db.prepare("SELECT daten FROM kennzahlen WHERE id = 1").first();
    return row?.daten ? JSON.parse(row.daten) : null;
  } catch {
    return null;
  }
}

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
export function adminOk(request, env) {
  if (!env.ADMIN_TOKEN) return true;
  return request.headers.get("X-Admin-Token") === env.ADMIN_TOKEN;
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
/**
 * Schluessel fuer den Zwischenspeicher: Pfad plus die Parameter, die der
 * Worker ueberhaupt liest, in fester Reihenfolge. Alles andere faellt weg -
 * auch die Snapshot-Nummer s und der Cache-Buster _ des Browsers.
 *
 * Vorher war die volle URL der Schluessel. Ein angehaengtes "&x=zufall"
 * umging damit den Speicher bei jedem Aufruf, und eine teure Abfrage liesse
 * sich beliebig oft direkt gegen die Datenbank schicken - genug, um ihr
 * Tageskontingent leerzulesen. Die Nummer s braucht nur der Browser, um SEINEN
 * Zwischenspeicher zu umgehen; hier haelt ein Eintrag ohnehin nur Sekunden bis
 * Minuten.
 */
const CACHE_PARAMETER = [
  "period", "limit", "offset", "tier", "nur_wallets", "nur_dienste", "min_etn", "max_etn",
  "type", "incl_auto", "addrs", "q", "top", "min_tage", "tage", "min_severity",
];

export function cacheSchluessel(u) {
  const k = new URL(u.origin + u.pathname);
  for (const name of CACHE_PARAMETER) {
    const wert = u.searchParams.get(name);
    if (wert != null && wert !== "") k.searchParams.set(name, wert.slice(0, 400));
  }
  return new Request(k.toString());
}

/** Besucher-Abruf beim Explorer: Budget aufgebraucht -> 429, sonst normal. */
export const liveAntwort = (d) =>
  d instanceof Response
    ? d
    : d?.beschaeftigt
      ? json({ error: "The explorer is busy right now - try again in a minute.", beschaeftigt: true }, 429, 0)
      : json(d);

const NOTLAUF_TAGE = 7;

/** Schluessel der Zweitschrift: dieselbe URL, aber ohne Cache-Buster - sonst
 *  legte jeder Aufruf mit ?_=<zeit> seine eigene an und faende nie eine. */
function notlaufSchluessel(u) {
  const k = new URL(u);
  k.searchParams.delete("_");
  k.pathname = "/__notlauf" + k.pathname;
  return new Request(k.toString());
}

export async function notlaufSchreiben(cache, u, antwort) {
  const kopie = new Response(antwort.body, antwort);
  kopie.headers.set("cache-control", "public, max-age=" + NOTLAUF_TAGE * 86400);
  kopie.headers.set("x-notlauf-stand", new Date().toISOString());
  await cache.put(notlaufSchluessel(u), kopie);
}

/** Liefert die Zweitschrift, falls es eine gibt - sonst null. */
export async function notlaufLesen(cache, u) {
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
