// What if: Marktkapitalisierungen holen und ablegen (src/marketcaps.js) und
// daraus die Antwort fuer den Reiter bauen (src/api/whatif.js). CoinGecko wird
// nachgebaut - der Test fragt nie das echte Netz.
import { repoUrl, frischeDb, pruefer } from "./hilfen.mjs";

const db = await frischeDb("whatif");
const { marktkapitalisierungen } = await import(repoUrl("src/marketcaps.js"));
const { whatif } = await import(repoUrl("src/api/whatif.js"));
const { pruef, ende } = pruefer();

// 300 Coins: Platz 1 Bitcoin, Platz 2 Tether (Stablecoin), Platz 25 Stellar,
// Platz 200 ein unbekannter Coin; der Rest heisst coin-<rang>.
const alle = Array.from({ length: 300 }, (_, i) => {
  const rang = i + 1;
  const id = { 1: "bitcoin", 2: "tether", 25: "stellar", 200: "irgendwas" }[rang] ?? "coin-" + rang;
  return { id, symbol: id.slice(0, 4), name: id, market_cap_rank: rang, market_cap: 1e12 / rang };
});
const abrufe = [];
globalThis.fetch = async (url, opt) => {
  abrufe.push({ url: String(url), ua: opt?.headers?.["user-agent"] });
  const u = new URL(url);
  const pro = Number(u.searchParams.get("per_page"));
  const seite = Number(u.searchParams.get("page"));
  return new Response(JSON.stringify(alle.slice((seite - 1) * pro, seite * pro)));
};

const jetzt = Date.parse("2026-09-16T04:40:00Z");
const r1 = await marktkapitalisierungen({}, db, { jetzt });
pruef(r1.coins === 300 && abrufe.length === 2, "zwei Abrufe liefern die Top 300");
pruef(abrufe.every((a) => a.ua), "CoinGecko bekommt eine Kennung (ohne kommt 403)");
const plaetze = db.db.prepare("SELECT MIN(rang) a, MAX(rang) b, COUNT(*) n FROM coin_caps").get();
pruef(plaetze.a === 1 && plaetze.b === 300 && plaetze.n === 300, "Plaetze 1 bis 300 liegen vollstaendig in der Tabelle");

const r2 = await marktkapitalisierungen({}, db, { jetzt: jetzt + 3 * 3600000 });
pruef(r2.coins === 0 && abrufe.length === 2, "drei Stunden spaeter wird nicht erneut gefragt");

// Ein Coin faellt aus den Top 300: er darf nicht mit altem Stand liegen bleiben.
alle[199] = { ...alle[199], id: "neuling", name: "neuling" };
await marktkapitalisierungen({}, db, { jetzt: jetzt + 25 * 3600000 });
pruef(abrufe.length === 4, "am naechsten Tag wird wieder geholt");
pruef(!db.db.prepare("SELECT 1 FROM coin_caps WHERE id='irgendwas'").get(), "herausgefallene Coins verschwinden");

// Fehlerhafte Antwort: alte Liste bleibt stehen.
globalThis.fetch = async () => new Response("rate limited", { status: 429 });
let fehler = null;
try { await marktkapitalisierungen({}, db, { jetzt: jetzt + 50 * 3600000 }); } catch (e) { fehler = e.message; }
pruef(/429/.test(fehler ?? "") && db.db.prepare("SELECT COUNT(*) n FROM coin_caps").get().n === 300, "bei 429 bleibt die alte Liste erhalten");

// --- Antwort fuer den Reiter -------------------------------------------------
db.db.prepare(
  "INSERT INTO snapshots (taken_at, day, total_supply, bridge_wei, etn_price, status) VALUES (?,?,?,?,?, 'ok')"
).run("2026-09-16T04:37:00Z", "2026-09-16", 18e9, (8e9 * 1e18).toLocaleString("fullwide", { useGrouping: false }), 0.001);
const d = await whatif(db, {});
pruef(d.etn.gesamt === 18e9 && Math.abs(d.etn.migriert - 10e9) < 1, "Menge: alles 18 Mrd., migriert 10 Mrd.");
pruef(d.etn.preis === 0.001, "aktueller Kurs aus dem letzten Snapshot");
pruef(!d.coins.some((c) => c.i === "tether"), "Stablecoins sind nicht in der Liste");
pruef(d.coins.length === 299 && d.coins[0].i === "bitcoin", "Liste nach Rang, Bitcoin zuerst");
pruef(d.schnell.map((g) => g.titel).join() === "Top 10,Top 30,Top 50,Top 100,Top 150,Top 300", "Schnellauswahl in sechs Bereichen");
pruef(d.schnell[0].ids[0] === "bitcoin" && d.schnell[1].ids[0] === "stellar", "bekannte Namen stehen im Bereich vorne");
pruef(d.schnell.every((g) => g.ids.length === 2), "zwei Coins je Bereich");
pruef(d.stand === new Date(jetzt + 25 * 3600000).toISOString(), "Stand der Daten wird mitgeliefert");

const leer = await whatif(await frischeDb("whatif-leer"), {});
pruef(leer.coins.length === 0 && leer.schnell.length === 0 && leer.stand === null, "ohne Daten eine leere, aber gueltige Antwort");

ende();
