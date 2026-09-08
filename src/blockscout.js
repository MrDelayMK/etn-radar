// Client fuer die Blockscout-API der Electroneum Smart Chain.
// Getestet gegen Blockscout v7.0.2 auf blockexplorer.electroneum.com.

const UA = "etn-radar/0.1 (+https://etn-radar.galacticsl.com)";
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Drosselung
//
// Der Explorer ist eine oeffentliche, unbezahlte Ressource und antwortet mit
// HTTP 429, wenn man ihn ueberfaehrt. Deshalb laufen ALLE Anfragen dieses
// Moduls durch eine gemeinsame Bremse - unabhaengig davon, wie viele
// Worker parallel arbeiten. Parallelitaet erhoeht dann nur noch die
// Auslastung der Wartezeit, nicht die Anfragerate.
// ---------------------------------------------------------------------------
const DROSSEL = {
  minAbstandMs: 300, // ca. 3 Anfragen pro Sekunde
  kette: Promise.resolve(),
  pauseBis: 0,
  gedrosselt: 0,
};

/** Setzt die Rate. 0 schaltet die Bremse ab (nur fuer Tests sinnvoll). */
export function setRate(anfragenProSekunde) {
  DROSSEL.minAbstandMs = anfragenProSekunde > 0 ? Math.ceil(1000 / anfragenProSekunde) : 0;
}
export const drosselStatus = () => ({ gedrosselt: DROSSEL.gedrosselt });

/** Reiht die naechste Anfrage ein und wartet, bis sie an der Reihe ist. */
function anstellen() {
  const naechste = DROSSEL.kette.then(async () => {
    // Nach einem 429 pausieren ALLE Anfragen, nicht nur die betroffene.
    const rest = DROSSEL.pauseBis - Date.now();
    if (rest > 0) await schlaf(rest);
    if (DROSSEL.minAbstandMs) await schlaf(DROSSEL.minAbstandMs);
  });
  DROSSEL.kette = naechste.catch(() => {});
  return naechste;
}

async function getJson(url, { retries = 4, timeoutMs = 25000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await anstellen();
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: ctl.signal,
        });

        if (res.status === 429) {
          // Retry-After beachten, sonst 5s/15s/45s. Die Pause gilt global.
          const retryAfter = Number(res.headers.get("retry-after"));
          const warten = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 5000 * Math.pow(3, attempt);
          DROSSEL.pauseBis = Math.max(DROSSEL.pauseBis, Date.now() + warten);
          DROSSEL.gedrosselt++;
          lastErr = new Error("HTTP 429 (zu viele Anfragen), Pause " + Math.round(warten / 1000) + "s");
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} bei ${url}`);
        return await res.json();
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await schlaf(800 * Math.pow(3, attempt));
    }
  }
  throw lastErr;
}

// Blockscout liefert transaction_count gelegentlich als "" (leerer String)
// und coin_balance theoretisch als null. Beides hier abfangen, sonst
// kippt der ganze Snapshot an einer einzigen kaputten Zeile.
function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeAddress(item) {
  const wei = item.coin_balance ?? "0";
  return {
    // Durchgaengig lowercase als Schluessel: Blockscout liefert die Adresse in
    // der Liste checksummed, in next_page_params aber lowercase. Ein Mix
    // davon fuehrt zu doppelten Zeilen fuer dasselbe Wallet.
    hash: String(item.hash).toLowerCase(),
    checksum: item.hash,
    balance_wei: String(wei),
    etn: Number(BigInt(wei) / 10n ** 12n) / 1e6, // 6 Nachkommastellen, ohne Praezisionsverlust bei grossen Werten
    tx_count: toInt(item.transaction_count),
    is_contract: item.is_contract ? 1 : 0,
    contract_name: item.name ?? null,
    impl_name: item.implementations?.[0]?.name ?? null,
    ens_name: item.ens_domain_name ?? null,
    is_scam: item.is_scam ? 1 : 0,
  };
}

/**
 * Holt die Top-N-Adressen nach Coin-Balance (absteigend).
 * Cursor-Pagination, 50 Adressen pro Seite.
 * onProgress(geladen, seiten) wird nach jeder Seite gerufen.
 */
export async function fetchTopAddresses(apiBase, topN, onProgress) {
  const items = [];
  let next = null;
  let pages = 0;
  let meta = null;
  const maxPages = Math.ceil(topN / 50) + 2;

  while (items.length < topN && pages < maxPages) {
    const qs = next
      ? "?" + new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)]))
      : "";
    const data = await getJson(`${apiBase}/addresses${qs}`);
    meta = data;
    const batch = data.items ?? [];
    if (batch.length === 0) break;
    items.push(...batch);
    pages++;
    next = data.next_page_params;
    if (onProgress) onProgress(items.length, pages);
    if (!next) break;
  }

  const rows = items.slice(0, topN).map(normalizeAddress);
  // Rang defensiv selbst vergeben statt der API-Reihenfolge zu vertrauen.
  //
  // Der Vergleich muss bei GLEICHEM Bestand 0 liefern und dann nach der
  // Adresse entscheiden. Vorher gab er auch bei Gleichstand -1 zurueck - eine
  // in sich widerspruechliche Ordnung, aus der die Sortierung bei jedem Lauf
  // eine andere Reihenfolge machen kann. Zwei Wallets mit demselben Betrag
  // haetten dann alle 30 Minuten die Raenge getauscht: erfundene
  // Rangaenderungen im Leaderboard und zwei ueberfluessige Schreibvorgaenge
  // pro Snapshot, dauerhaft.
  rows.sort((a, b) => {
    const x = BigInt(a.balance_wei);
    const y = BigInt(b.balance_wei);
    if (y > x) return 1;
    if (y < x) return -1;
    return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
  });
  rows.forEach((r, i) => (r.rank_pos = i + 1));

  return {
    rows,
    pages,
    total_supply: meta?.total_supply ?? null, // in ETN, nicht Wei
    exchange_rate: meta?.exchange_rate ? Number(meta.exchange_rate) : null,
  };
}

/** Netzwerk-Kennzahlen (Preis, Blockhoehe, Marktkapitalisierung). */
export async function fetchStats(apiBase) {
  const d = await getJson(`${apiBase}/stats`);
  return {
    total_blocks: toInt(d.total_blocks),
    total_addresses: toInt(d.total_addresses),
    coin_price: d.coin_price ? Number(d.coin_price) : null,
    market_cap: d.market_cap ? Number(d.market_cap) : null,
    gas_prices: d.gas_prices ?? null,
    roh: d,
  };
}

/**
 * Transaktionsverlauf der letzten Tage (fuer die Netzwerk-Kachel).
 * Fehlt der Endpoint, ist das kein Grund, den Lauf abzubrechen.
 */
export async function fetchTxChart(apiBase) {
  try {
    const d = await getJson(`${apiBase}/stats/charts/transactions`);
    return d?.chart_data ?? d?.chartData ?? null;
  } catch {
    return null;
  }
}

/**
 * Einzelne Adresse - fuer Wallets, die aus den Top N gefallen sind.
 *
 * ACHTUNG: Dieser Endpoint liefert KEIN transaction_count (anders als die
 * Listen-Abfrage). tx_count ist hier also immer null und darf einen bereits
 * bekannten Wert nicht ueberschreiben - siehe COALESCE in src/ingest.js.
 */
export async function fetchAddress(apiBase, hash) {
  const d = await getJson(`${apiBase}/addresses/${hash}`);
  return {
    ...normalizeAddress(d),
    tx_count: null,
    block_number: d.block_number_balance_updated_at ?? null,
  };
}

/**
 * Einzelne Balance-AENDERUNGEN einer Adresse, neueste zuerst.
 *
 * Wichtig als Ergaenzung zu fetchDailyHistory: dieser Endpoint ist zeitlich
 * NICHT auf 90 Tage begrenzt und liefert damit das echte Datum der letzten
 * Bewegung - auch wenn sie Jahre zurueckliegt. Genau das braucht die
 * Schlaefer-Erkennung.
 */
export async function fetchBalanceChanges(apiBase, hash, opts = {}) {
  // Eine Seite = 50 Aenderungen. Bei ruhigen Wallets deckt das die gesamte
  // Vergangenheit ab. Bei sehr aktiven (Boersen, tausende Transaktionen)
  // reichen 50 Aenderungen aber teils nur wenige Tage - dann fehlt der
  // Stuetzpunkt fuer laengere Zeitraeume wie 6M. Darum wird weitergeblaettert,
  // bis der gewuenschte Zeitraum abgedeckt oder das Seitenlimit erreicht ist.
  const maxPages = opts.maxPages ?? 1;
  const bisTage = opts.bisTage ?? null; // wie weit zurueck mindestens
  const grenze = bisTage ? Date.now() - bisTage * 86400000 : null;

  const out = [];
  let next = null;
  for (let seite = 0; seite < maxPages; seite++) {
    const qs = next
      ? "?" + new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)]))
      : "";
    const d = await getJson(`${apiBase}/addresses/${hash}/coin-balance-history${qs}`);
    const items = (d.items ?? []).filter((i) => i.block_timestamp);
    out.push(
      ...items.map((i) => ({
        at: i.block_timestamp,
        block: toInt(i.block_number),
        balance_wei: String(i.value ?? "0"),
        delta_wei: i.delta != null ? String(i.delta) : null,
      }))
    );
    next = d.next_page_params;
    if (!next || items.length === 0) break;
    // Weit genug zurueck? Dann aufhoeren.
    if (grenze && Date.parse(out[out.length - 1].at) < grenze) break;
  }
  return out; // neueste zuerst
}

/**
 * Tagesgenauer Balance-Verlauf einer Adresse (~90-Tage-Fenster).
 * Liefert nur Tage MIT Aenderung, plus einen Abschlusswert fuer heute.
 *
 * ACHTUNG: Bei Wallets, die sich im Fenster gar nicht bewegt haben, kommt eine
 * LEERE Liste zurueck - nicht etwa eine flache Linie. Wer daraus auf "keine
 * Historie" schliesst, datiert genau die laengsten Schlaefer falsch.
 * Siehe Fallback in scripts/backfill.mjs.
 */
export async function fetchDailyHistory(apiBase, hash) {
  const d = await getJson(`${apiBase}/addresses/${hash}/coin-balance-history-by-day`);
  return (d.items ?? [])
    .filter((i) => i.date && i.value != null)
    .map((i) => ({
      day: i.date,
      balance_wei: String(i.value),
      etn: Number(BigInt(i.value) / 10n ** 12n) / 1e6,
    }));
}

/**
 * Eingehende native ETN-Transaktionen einer Adresse, neueste zuerst.
 * Grundlage der Cluster-Vermutungen (src/clusters.js): von wem hat dieses
 * Wallet ETN erhalten, und teilen sich mehrere Wallets dieselbe Quelle?
 *
 * Es gibt KEIN "sort=asc" o.ae., das Ergebnis wirklich umkehrt (getestet -
 * das aelteste bekannte Element bleibt trotz des Parameters dasselbe). Um an
 * die aeltesten Eingaenge zu kommen, muss man bis zum Ende paginieren - bei
 * sehr aktiven Wallets (Boersen) macht das ein Seitenlimit noetig, siehe
 * maxPages in src/clusters.js.
 *
 * Ausschliesslich blockexplorer.electroneum.com, keine andere Quelle.
 */
/**
 * Native ETN-Transaktionen einer Adresse in eine Richtung, neueste zuerst.
 * Gemeinsamer Kern fuer fetchInboundTransactions/fetchOutboundTransactions.
 */
async function fetchTransactions(apiBase, hash, richtung, opts = {}) {
  const maxPages = opts.maxPages ?? 6;
  // Optional: aufhoeren, sobald die Seite aelter als dieser Zeitpunkt ist.
  // Ohne das kostet "letzte 7 Tage" genauso viele Anfragen wie "letzte 90".
  const bisZeit = opts.bisZeit ? Date.parse(opts.bisZeit) : null;
  const gegenpartFeld = richtung === "to" ? "from" : "to";
  const out = [];
  let next = null;
  let seite = 0;
  for (; seite < maxPages; seite++) {
    const qs =
      "?filter=" + richtung +
      (next
        ? "&" + new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)]))
        : "");
    const d = await getJson(`${apiBase}/addresses/${hash}/transactions${qs}`);
    const items = (d.items ?? []).filter((i) => i.value != null && i[gegenpartFeld]?.hash);
    out.push(
      ...items.map((i) => ({
        hash: i.hash,
        gegenpart: String(i[gegenpartFeld].hash).toLowerCase(),
        value_wei: String(i.value),
        etn: Number(BigInt(i.value) / 10n ** 12n) / 1e6,
        timestamp: i.timestamp,
      }))
    );
    next = d.next_page_params;
    // Die Liste kommt neueste zuerst: ist der letzte Eintrag der Seite schon
    // aelter als das Fenster, liegt alles Weitere ebenfalls davor.
    const letzte = (d.items ?? [])[d.items.length - 1]?.timestamp;
    const amZiel = bisZeit && letzte && Date.parse(letzte) < bisZeit;
    if (!next || items.length === 0 || amZiel) {
      // Unterscheiden, WARUM Schluss ist: sauber am Zeitfenster angekommen
      // (dann ist das Ergebnis vollstaendig) oder Historie zu Ende. Nur wer
      // am Seitendeckel scheitert, hat ein unvollstaendiges Ergebnis - sonst
      // warnt die Oberflaeche grundlos bei jedem aktiven Wallet.
      return { transfers: out, seiten: seite + 1, gedeckelt: false, vollstaendig: true };
    }
  }
  return { transfers: out, seiten: maxPages, gedeckelt: next != null, vollstaendig: false };
}

/** Eingehende Transaktionen. Grundlage der Cluster-Vermutungen. */
export async function fetchInboundTransactions(apiBase, hash, opts = {}) {
  const r = await fetchTransactions(apiBase, hash, "to", opts);
  // Rueckwaertskompatibel: bisherige Aufrufer erwarten das Feld "from".
  return { ...r, transfers: r.transfers.map((t) => ({ ...t, from: t.gegenpart })) };
}

/** Ausgehende Transaktionen. Grundlage der automatischen Boersen-Erkennung. */
export async function fetchOutboundTransactions(apiBase, hash, opts = {}) {
  const r = await fetchTransactions(apiBase, hash, "from", opts);
  return { ...r, transfers: r.transfers.map((t) => ({ ...t, to: t.gegenpart })) };
}

/**
 * Interne Transaktionen einer Adresse (Value-Transfers, die als Nebeneffekt
 * von Contract-Code passieren), neueste zuerst. Grundlage der
 * Bridge-Migrationsereignisse: die ETNBridge sendet ETN NICHT ueber normale
 * Top-Level-Transaktionen (die Liste ist dort leer - selbst gegengeprueft),
 * sondern ausschliesslich ueber interne Transfers innerhalb der Contract-Logik.
 *
 * Ruft optional weiter, bis entweder maxPages erreicht ist ODER der aelteste
 * Eintrag der aktuellen Seite aelter als `bisZeit` ist - fuer "hole genug, um
 * bis zu diesem Datum zurueckzukommen" ohne pauschal Hunderte Seiten zu holen.
 */
export async function fetchInternalTransactions(apiBase, hash, opts = {}) {
  const maxPages = opts.maxPages ?? 10;
  const bisZeit = opts.bisZeit ? new Date(opts.bisZeit).getTime() : null;
  // Zeitbudget statt reinem Seitendeckel: wie viele Seiten eine Stunde
  // hergibt, haengt an der Aktivitaet der Bridge und an der Laune des
  // Explorers. Ein Deckel in Sekunden ist die Groesse, die man wirklich
  // planen kann - danach richtet sich das Zeitlimit des Workflows.
  const frist = opts.fristMs ? Date.now() + opts.fristMs : null;
  const out = [];
  // Mit startCursor setzt der Aufruf dort fort, wo ein frueherer aufgehoert
  // hat. Die Bridge-Historie reicht bis Maerz 2024 zurueck und ist nur von
  // der neuesten Seite aus rueckwaerts erreichbar - ohne Fortsetzen muesste
  // jeder Lauf die ganze Strecke neu gehen.
  let next = opts.startCursor ?? null;
  let seite = 0;
  for (; seite < maxPages; seite++) {
    const qs = next
      ? "?" + new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)]))
      : "";
    const d = await getJson(`${apiBase}/addresses/${hash}/internal-transactions${qs}`);
    const items = (d.items ?? []).filter(
      (i) => i.value != null && BigInt(i.value) > 0n && i.to?.hash && i.success !== false
    );
    out.push(
      ...items.map((i) => ({
        hash: i.transaction_hash,
        to: String(i.to.hash).toLowerCase(),
        value_wei: String(i.value),
        etn: Number(BigInt(i.value) / 10n ** 12n) / 1e6,
        timestamp: i.timestamp,
      }))
    );
    next = d.next_page_params;
    const letzte = (d.items ?? [])[d.items.length - 1]?.timestamp;
    const amZiel = bisZeit && letzte && Date.parse(letzte) <= bisZeit;
    const zeitAus = frist != null && Date.now() >= frist;
    if (!next || (d.items ?? []).length === 0 || amZiel || zeitAus) {
      seite++;
      break;
    }
  }
  return { transfers: out, seiten: seite, gedeckelt: next != null, cursor: next };
}
