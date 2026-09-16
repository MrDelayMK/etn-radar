// Fuehrt die Tests in tests/ aus - jede Datei als eigener Prozess, damit sich
// Explorer-Drossel und Zwischenspeicher der Tests nicht gegenseitig beeinflussen.
//
//   npm test                  alle (dauert gut zwei Minuten: die Drossel ist echt)
//   npm run test:schnell      ohne die langsamen Explorer-Tests
//
// Vor jedem Ausrollen laufen lassen.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ORDNER = fileURLToPath(new URL("../tests/", import.meta.url));
// Diese Tests gehen durch die echte Explorer-Drossel (hoechstens 1,5 Anfragen
// pro Sekunde) und brauchen darum jeweils Sekunden bis eine Minute.
const LANGSAM = ["drossel", "sicherheit", "bridge-historie", "scanfehler", "census-wallets"];
const schnell = process.argv.includes("--schnell");

const dateien = readdirSync(ORDNER)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !schnell || !LANGSAM.some((l) => f.startsWith(l)))
  .sort();

let rot = 0;
for (const f of dateien) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [ORDNER + f], { encoding: "utf8" });
  const ausgabe = (r.stdout ?? "") + (r.stderr ?? "");
  const ok = r.status === 0;
  const hinweis = /uebersprungen/.test(ausgabe) ? "  - uebersprungen, keine lokale Datenbank" : "";
  console.log((ok ? "OK    " : "ROT   ") + f + "  (" + Math.round((Date.now() - t0) / 1000) + " s)" + hinweis);
  if (!ok) {
    rot++;
    const zeilen = ausgabe.split(/\r?\n/).filter((z) => /FEHLER|Error|fehlgeschlagen/.test(z));
    console.log("      " + (zeilen.length ? zeilen.slice(0, 8).join("\n      ") : ausgabe.slice(-600)));
  }
}
console.log(rot ? "\n" + rot + " von " + dateien.length + " Testdateien rot" : "\nAlle " + dateien.length + " Testdateien gruen");
process.exitCode = rot ? 1 : 0;
