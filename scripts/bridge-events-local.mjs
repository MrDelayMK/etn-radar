// Bridge-Migrationsereignisse gegen die lokale SQLite-Datei.
//   node scripts/bridge-events-local.mjs [minuten] ./data/etn.db
//
// Der Lauf setzt fort, wo der letzte aufgehoert hat - zum Ausprobieren reicht
// ein kleines Budget, etwa 1.

import { LocalDB } from "./local-db.mjs";
import { runBridgeEventAnalysis } from "../src/bridge-events.js";

const budgetMinuten = process.argv[2] ? Number(process.argv[2]) : undefined;
const dbPath = process.argv[3] ?? "./data/etn.db";
const db = new LocalDB(dbPath);

const env = {
  EXPLORER_API: "https://blockexplorer.electroneum.com/api/v2",
  BRIDGE_ADDRESS: "0xB7990022d3F22B6FB3afb626E05289ee3bf0AE62",
};

try {
  const res = await runBridgeEventAnalysis(env, db, { budgetMinuten, log: (m) => console.log(m) });
  console.log("\nFertig:", JSON.stringify(res));
} finally {
  db.close();
}
