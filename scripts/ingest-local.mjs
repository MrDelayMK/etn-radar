// Snapshot in eine lokale SQLite-Datei ziehen - zum Testen und Entwickeln.
//
//   node scripts/ingest-local.mjs [topN] [dbPfad]
//
// Beispiel:  node scripts/ingest-local.mjs 500 ./data/etn.db

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { LocalDB } from "./local-db.mjs";
import { runIngest } from "../src/ingest.js";

const topN = process.argv[2] ?? "500";
const dbPath = process.argv[3] ?? "./data/etn.db";

mkdirSync(dirname(dbPath), { recursive: true });
const fresh = !existsSync(dbPath);
const db = new LocalDB(dbPath);

// Schema ist idempotent (CREATE TABLE IF NOT EXISTS), also immer anwenden.
db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
if (fresh) console.log("Neue Datenbank angelegt: " + dbPath);

const env = {
  EXPLORER_API: "https://blockexplorer.electroneum.com/api/v2",
  TRACK_TOP_N: String(topN),
  BRIDGE_ADDRESS: "0xB7990022d3F22B6FB3afb626E05289ee3bf0AE62",
};

const t0 = Date.now();
try {
  const res = await runIngest(env, db, {
    log: (m) => console.log(m),
    onProgress: (n, p) => {
      if (p % 10 === 0) process.stdout.write("    ... " + n + " Adressen\r");
    },
  });
  console.log("\nErgebnis:", JSON.stringify(res, null, 2));
} catch (e) {
  console.error("FEHLGESCHLAGEN:", e.message);
  process.exitCode = 1;
} finally {
  console.log("Gesamtlaufzeit: " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  db.close();
}
