// Verlauf fuer Wallets ausserhalb der Top N (walletVerlauf in src/api/wallets.js):
// eine Explorer-Anfrage beim Oeffnen, dann zwoelf Stunden Ruhe je Wallet. Der
// Explorer wird nachgebaut - der Test fragt nie das echte Netz.
import { repoUrl, frischeDb, pruefer } from "./hilfen.mjs";

const db = await frischeDb("wallet-verlauf");
const { walletVerlauf } = await import(repoUrl("src/api/wallets.js"));
const { pruef, ende } = pruefer();

const env = { EXPLORER_API: "https://explorer.test/api/v2" };
const wei = (etn) => (BigInt(Math.round(etn * 1e6)) * 10n ** 12n).toString();
let antwort = [];
const abrufe = [];
globalThis.fetch = async (url) => {
  abrufe.push(String(url));
  return new Response(JSON.stringify({ items: antwort, next_page_params: null }), {
    headers: { "content-type": "application/json" },
  });
};

const fremd = "0x" + "a".repeat(40);
// Neueste zuerst, zwei Aenderungen am selben Tag: der Tag endet mit 150.
antwort = [
  { block_timestamp: "2026-09-10T18:00:00Z", block_number: "3", value: wei(150), delta: wei(50) },
  { block_timestamp: "2026-09-10T08:00:00Z", block_number: "2", value: wei(100), delta: wei(-20) },
  { block_timestamp: "2025-01-05T08:00:00Z", block_number: "1", value: wei(120), delta: wei(120) },
];
const jetzt = Date.parse("2026-09-22T06:00:00Z");
const r1 = await walletVerlauf(db, env, fremd, jetzt);
pruef(abrufe.length === 1 && abrufe[0].includes("/coin-balance-history"), "beim ersten Oeffnen genau eine Anfrage");
pruef(r1.verlauf.length === 2 && r1.verlauf[1].etn === 150, "je Tag der Schlussstand");
pruef(r1.vollstaendig === true, "weniger als 50 Aenderungen = ganze Vergangenheit");
pruef(db.db.prepare("SELECT source FROM daily_balances WHERE address = ? LIMIT 1").get(fremd).source === "besuch", "abgelegt mit Quelle 'besuch'");

const r2 = await walletVerlauf(db, env, fremd, jetzt + 3600000);
pruef(abrufe.length === 1 && r2.verlauf.length === 2, "eine Stunde spaeter keine neue Anfrage");

antwort = [{ block_timestamp: "2026-09-22T09:00:00Z", block_number: "4", value: wei(200), delta: wei(50) }, ...antwort];
const r3 = await walletVerlauf(db, env, fremd, jetzt + 13 * 3600000);
pruef(abrufe.length === 2 && r3.verlauf.length === 3, "nach zwoelf Stunden kommt das Neue dazu");

// Snapshot-Werte sind genauer und bleiben stehen.
const alt = "0x" + "b".repeat(40);
db.db.prepare("INSERT INTO current_balances (address, rank_pos, balance_wei, etn, tier, updated_at, last_snapshot, in_top_n) VALUES (?,?,?,?,?,?,?,0)")
  .run(alt, 2999, wei(500), 500, "dust", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
db.db.prepare("INSERT INTO daily_balances (address, day, balance_wei, etn, source) VALUES (?,?,?,?,'snapshot')")
  .run(alt, "2026-09-10", wei(500), 500);
antwort = [{ block_timestamp: "2026-09-10T08:00:00Z", block_number: "2", value: wei(499), delta: wei(1) }];
await walletVerlauf(db, env, alt, jetzt);
pruef(db.db.prepare("SELECT etn FROM daily_balances WHERE address = ? AND day = '2026-09-10'").get(alt).etn === 500, "Snapshot wird nicht ueberschrieben");

// Top N: nichts beim Explorer, der Snapshot fuehrt den Verlauf ohnehin.
const top = "0x" + "c".repeat(40);
db.db.prepare("INSERT INTO current_balances (address, rank_pos, balance_wei, etn, tier, updated_at, last_snapshot, in_top_n) VALUES (?,?,?,?,?,?,?,1)")
  .run(top, 5, wei(9e6), 9e6, "whale", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
const vorher = abrufe.length;
await walletVerlauf(db, env, top, jetzt);
pruef(abrufe.length === vorher, "Top-N-Wallets kosten keine Anfrage");

// Minutenbudget aufgebraucht und noch nichts gespeichert: "gleich nochmal".
db.db.prepare("INSERT INTO live_budget (ts, art, kosten) VALUES (?,?,?)").run(new Date().toISOString(), "test", 60);
const leer = await walletVerlauf(db, env, "0x" + "d".repeat(40), jetzt);
pruef(leer.beschaeftigt === true && abrufe.length === vorher, "ohne Budget keine Anfrage");

const falsch = await walletVerlauf(db, env, "0x123", jetzt);
pruef(falsch instanceof Response && falsch.status === 400, "ungueltige Adresse wird abgewiesen");

ende();
