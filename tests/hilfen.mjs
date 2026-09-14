// Gemeinsame Hilfen fuer die Tests: Pfade, frische Datenbank, Pruef-Ausgabe.
//
// Die Tests fragen nie den echten Explorer oder die echte D1: fetch wird je
// Test nachgebaut, die Datenbank ist eine frische SQLite-Datei im Temp-Ordner.
// Nur die Tests mit "lokal" im Namen brauchen die lokale Kopie in data/etn.db
// und ueberspringen sich ohne sie.

import { rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../", import.meta.url));
export const repoUrl = (pfad) => new URL("../" + pfad, import.meta.url).href;
export const LOKALE_DB = join(REPO, "data", "etn.db");
export const BRIDGE = "0xB7990022d3F22B6FB3afb626E05289ee3bf0AE62";
export const ctx = { waitUntil() {}, passThroughOnException() {} };

export const tempPfad = (name) => join(tmpdir(), "etn-radar-test-" + name + "-" + process.pid + ".db");

function wegraeumen(pfad) {
  for (const f of [pfad, pfad + "-wal", pfad + "-shm"]) rmSync(f, { force: true });
}

/** Leere Datenbank mit dem vollen Schema. */
export async function frischeDb(name) {
  const pfad = tempPfad(name);
  wegraeumen(pfad);
  const { LocalDB } = await import(repoUrl("scripts/local-db.mjs"));
  const db = new LocalDB(pfad);
  db.exec(readFileSync(join(REPO, "schema.sql"), "utf8"));
  return db;
}

/** Kopie der lokalen Datenbank - oder null, wenn es keine gibt. */
export async function kopieDerLokalenDb(name) {
  if (!existsSync(LOKALE_DB)) return null;
  const pfad = tempPfad(name);
  wegraeumen(pfad);
  const { LocalDB } = await import(repoUrl("scripts/local-db.mjs"));
  // VACUUM INTO statt Dateikopie: die Datenbank laeuft im WAL-Modus, eine reine
  // Kopie der Hauptdatei verliert, was noch im Log steht.
  new LocalDB(LOKALE_DB).db.exec("VACUUM INTO '" + pfad.replace(/'/g, "''") + "'");
  return new LocalDB(pfad);
}

export function ohneZwischenspeicher() {
  globalThis.caches = { default: { async match() {}, async put() {} } };
}

export function pruefer() {
  let fehler = 0;
  return {
    pruef(ok, text) {
      console.log((ok ? "  ok     " : "  FEHLER ") + text);
      if (!ok) fehler++;
    },
    ende() {
      console.log(fehler ? "\n" + fehler + " Pruefung(en) fehlgeschlagen" : "\nAlle Pruefungen bestanden");
      process.exitCode = fehler ? 1 : 0;
    },
  };
}
