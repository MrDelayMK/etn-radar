// Marktkapitalisierung der 300 groessten Coins - fuer den What-if-Vergleich.
//
// Warum hier und nicht im Worker: CoinGecko sperrt die Adressen von Cloudflare
// Workers (403 ohne Kennung, 429 mit - siehe die Notiz in src/api/uebersicht.js).
// Der Snapshot-Lauf haengt dagegen an einer gewoehnlichen Leitung bei GitHub,
// dort geht es. Der Worker liest danach nur noch aus der eigenen Datenbank.
//
// Last nach draussen: drei Anfragen (Top 300 + Electroneum), einmal am Tag. Rund 90 im Monat, das
// Gratis-Kontingent liegt bei etwa 10.000.

const TAKT_MS = 20 * 3600000; // einmal taeglich, mit Luft fuer verspaetete Laeufe
// Top 300 in zwei Abrufen. Die Seitengroesse bestimmt, wo Seite 2 anfaengt -
// 150 und 150 ergibt die Plaetze 1 bis 300, 250 und 50 waeren 1-250 und 51-100.
const PRO_SEITE = 150;
const SEITEN = 2;
export const ETN_ID = "electroneum";
const URL_BASIS =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc" +
  "&sparkline=false&locale=en";

export async function marktkapitalisierungen(env, db, { log = () => {}, jetzt = Date.now() } = {}) {
  const letzte = await db
    .prepare("SELECT MAX(abgerufen) AS a FROM coin_caps")
    .first()
    .catch(() => null);
  if (letzte?.a && jetzt - Date.parse(letzte.a) < TAKT_MS) return { coins: 0 };

  const holen = async (url, was) => {
    // Ohne Kennung antwortet CoinGecko mit 403.
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "etn-radar" } });
    if (!r.ok) throw new Error("CoinGecko " + r.status + " auf " + was);
    const zeilen = await r.json();
    if (!Array.isArray(zeilen)) throw new Error("CoinGecko lieferte keine Liste");
    return zeilen;
  };
  const coins = [];
  for (let seite = 1; seite <= SEITEN; seite++) {
    coins.push(...(await holen(URL_BASIS + "&per_page=" + PRO_SEITE + "&page=" + seite, "Seite " + seite)));
  }
  // Electroneum selbst liegt weit hinter den Top 300 - fuer seinen Rang eine
  // dritte Anfrage. Die Seite zeigt ihn beim ETN-Kaertchen, nicht in der Liste.
  if (!coins.some((c) => c?.id === ETN_ID)) {
    coins.push(...(await holen(URL_BASIS + "&ids=" + ETN_ID, "Electroneum")));
  }

  const abgerufen = new Date(jetzt).toISOString();
  const brauchbar = coins
    .filter((c) => c?.id && c.symbol && Number(c.market_cap) > 0)
    .map((c) => ({
      id: String(c.id),
      symbol: String(c.symbol).toUpperCase(),
      name: String(c.name ?? c.id),
      rang: Number(c.market_cap_rank) || null,
      cap: Number(c.market_cap),
    }));
  if (brauchbar.length < 50) throw new Error("nur " + brauchbar.length + " Coins - Antwort sieht falsch aus");

  // Ganz ersetzen statt zusammenfuehren: ein Coin, der aus den Top 300 faellt,
  // stuende sonst mit seinem alten Stand fuer immer in der Liste.
  const ins = db.prepare(
    "INSERT INTO coin_caps (id, symbol, name, rang, market_cap, abgerufen) VALUES (?,?,?,?,?,?)" +
      " ON CONFLICT(id) DO UPDATE SET symbol = excluded.symbol, name = excluded.name," +
      " rang = excluded.rang, market_cap = excluded.market_cap, abgerufen = excluded.abgerufen"
  );
  const stmts = brauchbar.map((c) => ins.bind(c.id, c.symbol, c.name, c.rang, c.cap, abgerufen));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  await db.prepare("DELETE FROM coin_caps WHERE abgerufen < ?").bind(abgerufen).run();

  log("  Marktkapitalisierungen: " + brauchbar.length + " Coins");
  return { coins: brauchbar.length };
}
