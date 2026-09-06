// Bridge-Migrationsereignisse gegen die Cloudflare-D1-Datenbank (laeuft
// monatlich in einer GitHub Action, siehe .github/workflows/bridge-events.yml).
//   node scripts/bridge-events-remote.mjs [limit]

import { fromEnv } from "../src/db-http.js";
import { runBridgeEventAnalysis } from "../src/bridge-events.js";

const limitArg = process.argv[2] || process.env.BRIDGE_EVENTS_LIMIT;
const limit = limitArg ? Number(limitArg) : undefined;

const db = fromEnv();
const env = {
  EXPLORER_API: process.env.EXPLORER_API ?? "https://blockexplorer.electroneum.com/api/v2",
  BRIDGE_ADDRESS:
    process.env.BRIDGE_ADDRESS ?? "0xB7990022d3F22B6FB3afb626E05289ee3bf0AE62",
};

const res = await runBridgeEventAnalysis(env, db, { limit, log: (m) => console.log(m) });
console.log("\nFertig:", JSON.stringify(res));
console.log("D1-HTTP-Anfragen: " + db.requests);
