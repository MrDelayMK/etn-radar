// Tiefenzaehlung gegen die lokale SQLite-Datei.
//   node scripts/census-local.mjs [tiefe] [dbPfad]

import { LocalDB } from "./local-db.mjs";
import { runCensus } from "../src/census.js";

const depth = Number(process.argv[2] ?? 250000);
const dbPath = process.argv[3] ?? "./data/etn.db";
const db = new LocalDB(dbPath);

const env = { EXPLORER_API: "https://blockexplorer.electroneum.com/api/v2" };

try {
  await runCensus(env, db, {
    depth,
    log: (m) => console.log(m),
    onProgress: (n, p) => {
      if (p % 60 === 0) process.stdout.write("  " + n.toLocaleString("de-DE") + " Adressen\r");
    },
  });
} finally {
  db.close();
}
