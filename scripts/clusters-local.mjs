// Cluster-Analyse gegen die lokale SQLite-Datei.
//   node scripts/clusters-local.mjs [limit] ./data/etn.db
//
// limit begrenzt, wie viele Wallets analysiert werden (zum Testen). Ohne
// limit werden alle individuell verfolgten (Fast-Tier-)Wallets geprueft.

import { LocalDB } from "./local-db.mjs";
import { runClusterAnalysis } from "../src/clusters.js";

const limit = process.argv[2] ? Number(process.argv[2]) : undefined;
const dbPath = process.argv[3] ?? "./data/etn.db";
const db = new LocalDB(dbPath);

const env = {
  EXPLORER_API: "https://blockexplorer.electroneum.com/api/v2",
  BRIDGE_ADDRESS: "0xB7990022d3F22B6FB3afb626E05289ee3bf0AE62",
};

try {
  await runClusterAnalysis(env, db, {
    limit,
    log: (m) => console.log(m),
    onProgress: (n, total, eta) =>
      process.stdout.write("  " + n + "/" + total + "  Restzeit ~" + eta + "s   \r"),
  });
} finally {
  db.close();
}
