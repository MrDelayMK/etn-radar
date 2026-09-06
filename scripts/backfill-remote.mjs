// Backfill gegen die Cloudflare-D1-Datenbank (laeuft in der GitHub Action).
//   node scripts/backfill-remote.mjs [parallel]

import { fromEnv } from "../src/db-http.js";
import { runBackfill } from "../src/backfill.js";

const parallel = Number.parseInt(process.argv[2] ?? "3", 10);
const db = fromEnv();

await runBackfill(
  { EXPLORER_API: process.env.EXPLORER_API ?? "https://blockexplorer.electroneum.com/api/v2" },
  db,
  {
    parallel,
    log: (m) => console.log(m),
    onProgress: (done, total, eta) =>
      console.log("  " + done + "/" + total + "  Restzeit ~" + eta + "s"),
  }
);
console.log("D1-HTTP-Anfragen: " + db.requests);
console.log(db.schreibBericht());
