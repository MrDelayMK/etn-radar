// Automatische Boersen-Erkennung gegen die Cloudflare-D1-Datenbank (laeuft
// monatlich in einer GitHub Action, siehe .github/workflows/exchange-detect.yml).
//   node scripts/exchange-detect-remote.mjs [limit]

import { fromEnv } from "../src/db-http.js";
import { runExchangeDetection } from "../src/exchange-detect.js";

const limitArg = process.argv[2] || process.env.EXCHANGE_DETECT_LIMIT;
const limit = limitArg ? Number(limitArg) : undefined;

const db = fromEnv();
const env = {
  EXPLORER_API: process.env.EXPLORER_API ?? "https://blockexplorer.electroneum.com/api/v2",
  BRIDGE_ADDRESS:
    process.env.BRIDGE_ADDRESS ?? "0xB7990022d3F22B6FB3afb626E05289ee3bf0AE62",
};

await runExchangeDetection(env, db, {
  limit,
  log: (m) => console.log(m),
  onProgress: (n, total, eta) => console.log("  " + n + "/" + total + "  Restzeit ~" + eta + "s"),
});

console.log("D1-HTTP-Anfragen: " + db.requests);
