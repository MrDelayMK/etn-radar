// Einmalige Messung: wie tief muss man paginieren, um Wallets ab 25.000 bzw.
// 5.000 ETN vollstaendig zu zaehlen?
//
// Speichert NICHTS in die Datenbank - reines Auskundschaften, um zu wissen,
// ob eine "Dust-Tier"-Erweiterung technisch sinnvoll ist, bevor irgendetwas
// Produktives gebaut wird. Nutzt dieselbe globale Drosselung wie der Rest des
// Projekts (src/blockscout.js, ~3 Anfragen/s), damit der Explorer nicht
// erneut ueberfahren wird - EIN Durchlauf, kein wiederholtes Neuladen.
//
//   node scripts/tier-depth-probe.mjs [zielAdressen]

import { fetchTopAddresses } from "../src/blockscout.js";

const API = "https://blockexplorer.electroneum.com/api/v2";
const SCHWELLEN = [100000, 50000, 25000, 10000, 5000, 1000];
// Aus einer groben Hochrechnung (Potenzgesetz durch zwei bekannte Punkte):
// 5.000 ETN liegt bei ~Rang 140.000. Ziel mit 40% Sicherheitsspanne.
const ZIEL = Number(process.argv[2] ?? 200000);

console.log("Tiefenmessung: hole bis zu " + ZIEL.toLocaleString("de-DE") + " Adressen");
console.log("bei ~3 Anfragen/s sind das rund " + Math.round(ZIEL / 50 / 3 / 60) + " Minuten.\n");

const t0 = Date.now();
const { rows } = await fetchTopAddresses(API, ZIEL, (n, p) => {
  if (p % 60 === 0) {
    process.stdout.write(
      "  " + n.toLocaleString("de-DE") + " Adressen, " +
      Math.round((Date.now() - t0) / 1000) + "s   \r"
    );
  }
});

console.log("\n\nGeladen: " + rows.length.toLocaleString("de-DE") + " Adressen in " +
  Math.round((Date.now() - t0) / 60000) + " Minuten\n");

console.log("Schwelle        Wallets >=      Erreicht?");
for (const s of SCHWELLEN) {
  const idx = rows.findIndex((r) => r.etn < s);
  const erreicht = idx !== -1;
  const anzahl = erreicht ? idx : rows.length;
  console.log(
    "  >= " + String(s).padStart(6) + " ETN  " +
    anzahl.toLocaleString("de-DE").padStart(10) +
    (erreicht ? "   ja (vollstaendig)" : "   NEIN - Ziel war zu flach, tiefer als erfasst")
  );
}

const letzte = rows[rows.length - 1];
console.log("\ntiefste erreichte Balance: " + Math.round(letzte.etn).toLocaleString("de-DE") +
  " ETN bei Rang " + rows.length.toLocaleString("de-DE"));
