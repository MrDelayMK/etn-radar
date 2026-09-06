// Backfill gegen die lokale SQLite-Datei.
//   node scripts/backfill.mjs [dbPfad] [parallel]

import { LocalDB } from "./local-db.mjs";
import { runBackfill } from "../src/backfill.js";

const dbPath = process.argv[2] ?? "./data/etn.db";
const parallel = Number.parseInt(process.argv[3] ?? "3", 10);
const db = new LocalDB(dbPath);

try {
  await runBackfill(
    { EXPLORER_API: "https://blockexplorer.electroneum.com/api/v2" },
    db,
    {
      parallel,
      log: (m) => console.log(m),
      onProgress: (done, total, eta) =>
        process.stdout.write("  " + done + "/" + total + "  Restzeit ~" + eta + "s   \r"),
    }
  );
  const s = await db.prepare("SELECT MIN(day) a, MAX(day) b, COUNT(*) c FROM daily_balances").first();
  console.log("  Historie: " + s.a + " bis " + s.b + " (" + s.c + " Zeilen)");
} finally {
  db.close();
}
