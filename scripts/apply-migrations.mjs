// Wendet migrations.sql an - Zeile fuer Zeile, tolerant gegen "Spalte gibt es
// schon".
//
//   node scripts/apply-migrations.mjs           -> lokale SQLite (./data/etn.db)
//   node scripts/apply-migrations.mjs --remote  -> D1 ueber die HTTP-API
//
// Warum nicht `wrangler d1 execute --file=migrations.sql`: wrangler bricht
// beim ersten Fehler ab. Ein ALTER TABLE auf eine Spalte, die schon da ist,
// IST ein Fehler - bei einer frischen Datenbank also immer. Hier wird genau
// dieser eine Fehler uebersprungen und jeder andere weitergereicht.

import { readFileSync } from "node:fs";

const remote = process.argv.includes("--remote");
const sql = readFileSync(new URL("../migrations.sql", import.meta.url), "utf8");

// Kommentare raus, dann an Semikolons trennen.
const anweisungen = sql
  .split("\n")
  .filter((z) => !z.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const db = remote
  ? (await import("../src/db-http.js")).fromEnv()
  : new (await import("./local-db.mjs")).LocalDB(process.argv[2] ?? "./data/etn.db");

console.log(
  "Wende " + anweisungen.length + " Migration(en) an (" + (remote ? "D1 remote" : "lokal") + ") ..."
);

let neu = 0;
let schonDa = 0;
for (const a of anweisungen) {
  try {
    await db.prepare(a).run();
    neu++;
    console.log("  + " + a);
  } catch (e) {
    if (/duplicate column name/i.test(e.message)) {
      schonDa++;
      console.log("  = schon vorhanden: " + a.slice(0, 60));
    } else {
      throw e;
    }
  }
}

console.log("\nFertig: " + neu + " angewendet, " + schonDa + " bereits vorhanden.");
if (!remote) db.close();
