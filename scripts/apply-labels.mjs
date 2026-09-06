// Labels aus labels.json in die Datenbank schreiben.
//
//   node scripts/apply-labels.mjs ./data/etn.db     (lokal)
//   node scripts/apply-labels.mjs --remote           (Cloudflare D1)
//
// Idempotent: kann nach jeder Aenderung an labels.json erneut laufen.
// Ueberschreibt nur die Label-Felder, nie die Messdaten.

import { readFileSync } from "node:fs";
import { LocalDB } from "./local-db.mjs";
import { fromEnv } from "../src/db-http.js";

const remote = process.argv.includes("--remote");
const dbPath = process.argv.find((a) => !a.startsWith("--") && a.endsWith(".db")) ?? "./data/etn.db";
const db = remote ? fromEnv() : new LocalDB(dbPath);

const { labels } = JSON.parse(readFileSync(new URL("../labels.json", import.meta.url), "utf8"));
const jetzt = new Date().toISOString();

// Die Adresse kann noch unbekannt sein (Label vor dem ersten Snapshot gesetzt).
// Darum INSERT mit Konfliktbehandlung statt reinem UPDATE.
const upsert = db.prepare(
  "INSERT INTO addresses (hash, checksum_hash, first_seen, last_seen," +
    " label, label_type, label_source, notes, is_excluded)" +
    " VALUES (?,?,?,?,?,?,'manual',?,?)" +
    " ON CONFLICT(hash) DO UPDATE SET" +
    "   label        = excluded.label," +
    "   label_type   = excluded.label_type," +
    "   label_source = 'manual'," +
    "   notes        = excluded.notes," +
    "   is_excluded  = excluded.is_excluded"
);

const stmts = labels.map((l) =>
  upsert.bind(
    l.address.toLowerCase(),
    l.address,
    jetzt,
    jetzt,
    l.label,
    l.label_type ?? null,
    l.notes ?? null,
    l.is_excluded ?? 0
  )
);

await db.batch(stmts);
console.log(labels.length + " Labels geschrieben:");

for (const l of labels) {
  const r = await db
    .prepare(
      "SELECT c.etn, c.rank_pos FROM current_balances c WHERE c.address = ?"
    )
    .bind(l.address.toLowerCase())
    .first();
  const stand = r
    ? "Rang " + String(r.rank_pos).padStart(4) + "  " +
      Math.round(r.etn).toLocaleString("de-DE").padStart(15) + " ETN"
    : "noch nicht im Snapshot erfasst";
  console.log("  " + l.label.padEnd(12) + l.label_type.padEnd(10) + stand);
}

db.close();
