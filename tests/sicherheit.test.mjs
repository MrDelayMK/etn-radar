// Minutenbudget fuer Explorer-Abrufe und Cache-Schluessel - gegen einen
// nachgebauten Explorer und Zwischenspeicher, keine echte Anfrage.
import { repoUrl, frischeDb, pruefer, BRIDGE } from "./hilfen.mjs";

const worker = (await import(repoUrl("src/index.js"))).default;
const { pruef, ende } = pruefer();

let explorer = 0;
globalThis.fetch = async (url) => {
  explorer++;
  const u = new URL(String(url));
  if (u.pathname.includes("/transactions")) {
    return new Response(JSON.stringify({ items: [], next_page_params: null }), { headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ hash: "0x1", coin_balance: "5000000000000000000000" }), { headers: { "content-type": "application/json" } });
};

// Zwischenspeicher als Map: Schluessel ist die URL des Requests.
const speicher = new Map();
globalThis.caches = { default: {
  async match(req) { const r = speicher.get(req.url); return r ? r.clone() : undefined; },
  async put(req, res) { speicher.set(req.url, res); },
} };

const db = await frischeDb("sicherheit");
let dbAbfragen = 0;
const prepareEcht = db.prepare.bind(db);
db.prepare = (sql) => { dbAbfragen++; return prepareEcht(sql); };

const env = { DB: db, EXPLORER_API: "https://fake.test/api/v2", BRIDGE_ADDRESS: BRIDGE, MIGRATION_DEADLINE: "2027-01-31" };
const abruf = async (pfad) => {
  const warten = [];
  const r = await worker.fetch(new Request("http://localhost" + pfad), env, { waitUntil: (p) => warten.push(p), passThroughOnException() {} });
  await Promise.all(warten);
  return r;
};

// --- Cache-Schluessel: Zufallsparameter duerfen den Speicher nicht umgehen ---
dbAbfragen = 0;
await abruf("/api/leaderboard?limit=50&offset=0&s=101&x=zufall1");
const ersteAbfragen = dbAbfragen;
dbAbfragen = 0;
const r2 = await abruf("/api/leaderboard?offset=0&limit=50&s=102&x=zufall2&_=12345");
pruef(ersteAbfragen > 0 && dbAbfragen === 0, "zweiter Aufruf mit anderen Zufallsparametern kommt aus dem Speicher");
pruef(r2.status === 200, "Antwort aus dem Speicher ist 200");
const schluessel = [...speicher.keys()].filter((k) => !k.includes("__notlauf"));
pruef(schluessel.every((k) => !/[?&](s|x|_)=/.test(k)), "weder s, x noch _ im Schluessel");
dbAbfragen = 0;
await abruf("/api/leaderboard?limit=50&offset=50");
pruef(dbAbfragen > 0, "ein echter Parameter (offset) ergibt einen eigenen Eintrag");

// --- Minutenbudget: Suche nach unbekannten Adressen ------------------------
explorer = 0;
let erlaubt = 0, abgewiesen = 0, letzte = null;
for (let i = 0; i < 62; i++) {
  const adr = "0x" + (0xabc000 + i).toString(16).padStart(40, "0");
  const r = await abruf("/api/search?q=" + adr);
  if (r.status === 429) { abgewiesen++; letzte = await r.json(); } else if (r.status === 200) erlaubt++;
}
console.log("   Suche: " + erlaubt + " erlaubt, " + abgewiesen + " abgewiesen, Explorer-Anfragen " + explorer);
pruef(erlaubt === 60 && abgewiesen === 2, "genau 60 Explorer-Abrufe pro Minute, danach 429");
pruef(explorer === 60, "abgewiesene Suchen fragen den Explorer nicht");
pruef(letzte?.beschaeftigt === true, "429 traegt beschaeftigt=true");

// --- Money Flow reserviert 20 und korrigiert ------------------------------
await db.prepare("DELETE FROM live_budget").run();
explorer = 0;
const f1 = await abruf("/api/wallet-flows/0x1111111111111111111111111111111111111111?period=7d");
const summe = await db.prepare("SELECT sum(kosten) n FROM live_budget").first();
pruef(f1.status === 200 && summe.n === explorer, "Money Flow bucht genau die gelesenen Seiten (" + explorer + ")");
await db.prepare("INSERT INTO live_budget (ts, art, kosten) VALUES (?, 'test', 45)").bind(new Date().toISOString()).run();
explorer = 0;
const f2 = await abruf("/api/wallet-flows/0x2222222222222222222222222222222222222222?period=7d");
pruef(f2.status === 429 && explorer === 0, "reicht das Budget nicht, gibt es 429 ohne Explorer-Anfrage");

// --- Alte Budgetzeilen werden aufgeraeumt ---------------------------------
await db.prepare("INSERT INTO live_budget (ts, art, kosten) VALUES (?, 'alt', 1)").bind(new Date(Date.now() - 2 * 3600000).toISOString()).run();
await db.prepare("DELETE FROM live_budget WHERE art != 'alt'").run();
await abruf("/api/search?q=0x" + "d".repeat(40));
const alt = await db.prepare("SELECT count(*) n FROM live_budget WHERE art = 'alt'").first();
pruef(alt.n === 0, "Budgetzeilen aelter als eine Stunde verschwinden beim naechsten Abruf");

// --- Admin-Bereiche ohne Schluessel gesperrt -------------------------------
const mitSchluessel = { ...env, ADMIN_TOKEN: "geheim" };
const hol = (pfad, kopf = {}) => worker.fetch(new Request("http://localhost" + pfad, { headers: kopf }), mitSchluessel, { waitUntil() {}, passThroughOnException() {} });
pruef((await hol("/api/besuche")).status === 403, "Besucherzahlen ohne Schluessel: 403");
pruef((await hol("/api/feedback")).status === 403, "Posteingang ohne Schluessel: 403");
pruef((await hol("/api/feedback/neu", { "X-Admin-Token": "falsch" })).status === 403, "neues Feedback mit falschem Schluessel: 403");
pruef((await hol("/api/besuche", { "X-Admin-Token": "geheim" })).status === 200, "Besucherzahlen mit richtigem Schluessel: 200");

ende();
