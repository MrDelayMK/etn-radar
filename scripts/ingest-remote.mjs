// Snapshot direkt in die Cloudflare-D1-Datenbank schreiben.
// Laeuft in der GitHub Action (alle 6 Stunden) und lokal zum Testen.
//
//   node scripts/ingest-remote.mjs [topN]
//
// Erwartet in der Umgebung:
//   CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_API_TOKEN

import { fromEnv } from "../src/db-http.js";
import { runIngest } from "../src/ingest.js";

const topN = process.argv[2] ?? process.env.TRACK_TOP_N ?? "3000";

const db = fromEnv();
const env = {
  EXPLORER_API: process.env.EXPLORER_API ?? "https://blockexplorer.electroneum.com/api/v2",
  TRACK_TOP_N: String(topN),
  BRIDGE_ADDRESS:
    process.env.BRIDGE_ADDRESS ?? "0xB7990022d3F22B6FB3afb626E05289ee3bf0AE62",
};

const t0 = Date.now();
try {
  const res = await runIngest(env, db, {
    log: (m) => console.log(m),
    onProgress: (n, p) => {
      if (p % 20 === 0) console.log("    ... " + n + " Adressen geladen");
    },
  });
  console.log("\n" + JSON.stringify(res, null, 2));
  console.log("\nD1-HTTP-Anfragen: " + db.requests);
} catch (e) {
  console.error("\nFEHLGESCHLAGEN: " + e.message);
  process.exitCode = 1;
} finally {
  console.log("Gesamtlaufzeit: " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
}
