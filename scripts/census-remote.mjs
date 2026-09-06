// Tiefenzaehlung gegen die Cloudflare-D1-Datenbank (laeuft woechentlich in
// einer GitHub Action, siehe .github/workflows/census.yml).
//   node scripts/census-remote.mjs [tiefe]

import { fromEnv } from "../src/db-http.js";
import { runCensus } from "../src/census.js";

const depth = Number(process.argv[2] ?? process.env.CENSUS_DEPTH ?? 250000);
const db = fromEnv();

const env = {
  EXPLORER_API: process.env.EXPLORER_API ?? "https://blockexplorer.electroneum.com/api/v2",
};

const res = await runCensus(env, db, {
  depth,
  log: (m) => console.log(m),
  onProgress: (n, p) => {
    if (p % 200 === 0) console.log("  " + n.toLocaleString("de-DE") + " Adressen");
  },
});

console.log("\nD1-HTTP-Anfragen: " + db.requests);
if (!res.vollstaendig) {
  console.error("Tiefe hat nicht bis zur Dust-Grenze gereicht - CENSUS_DEPTH erhoehen.");
  process.exitCode = 1;
}
