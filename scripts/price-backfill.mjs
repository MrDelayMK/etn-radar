// Einmalige Kurshistorie in die eigene Datenbank holen.
//
//   node scripts/price-backfill.mjs            -> SQL auf die Standardausgabe
//   node scripts/price-backfill.mjs --local    -> direkt in ./data/etn.db
//
// WARUM UEBERHAUPT:
// Der Kursverlauf wurde erst live bei jedem Aufruf von aussen geholt. Das
// scheiterte reihenweise, und zwar nicht an der Programmierung, sondern an
// IP-Sperren:
//
//   CoinGecko     403 ohne User-Agent (Cloudflare Workers schicken keinen),
//                 mit Kennung dann 429 - das Gratis-Kontingent haengt an der
//                 IP, und Worker teilen sich ihre Adressen mit allen anderen.
//   Coinpaprika   402 aus dem Worker heraus, waehrend dieselbe URL von einem
//                 gewoehnlichen Anschluss 200 liefert.
//
// Gegen fremde IP-Sperren ist nichts auszurichten. Die Loesung ist, die
// Vergangenheit EINMAL von einem normalen Anschluss aus zu holen und danach
// aus den eigenen Snapshots weiterzuschreiben - die laufen ohnehin alle 30
// Minuten und tragen den Kurs mit. Im Betrieb braucht die Seite damit gar
// keine fremde Kursquelle mehr.
//
// WARUM COINGECKO UND NICHT COINPAPRIKA:
// Gegengerechnet an denselben Tagen. Coinpaprika liegt systematisch 4 bis 6
// Prozent ueber dem Kurs, den der Block-Explorer meldet - an der Nahtstelle
// zwischen nachgeladener Vergangenheit und eigenen Werten waere das ein
// sichtbarer Knick gewesen. CoinGecko stimmt mit den eigenen Werten auf unter
// ein halbes Prozent ueberein (06.09.: 0,0009843 gegen 0,0009805).
//
// Das Ergebnis kommt als SQL heraus, damit es ohne API-Token angewendet
// werden kann:
//
//   node scripts/price-backfill.mjs > kurse.sql
//   npx wrangler d1 execute etn-tracker --remote -y --file=kurse.sql

// 364 statt 365: mehr gibt der Gratis-Zugang nicht her (gemessen, nicht
// geraten - ab 365 Tagen kommt eine Absage).
const MAX_TAGE = 364;
const TAGE = Math.min(MAX_TAGE, Number(process.argv.find((a) => /^\d+$/.test(a)) ?? MAX_TAGE));
const lokal = process.argv.includes("--local");

const url =
  "https://api.coingecko.com/api/v3/coins/electroneum/market_chart" +
  "?vs_currency=usd&days=" + TAGE + "&interval=daily";

const res = await fetch(url, {
  headers: {
    accept: "application/json",
    // Ohne Kennung antwortet CoinGecko mit 403.
    "user-agent": "ETN-Radar/1.0 (+https://etn-radar.galacticsl.com)",
  },
});
if (!res.ok) {
  console.error("CoinGecko antwortete mit HTTP " + res.status);
  console.error("Von einem gewoehnlichen Anschluss aus geht es; aus Rechenzentren");
  console.error("heraus wird die Anfrage haeufig abgewiesen oder gedrosselt.");
  process.exit(1);
}
const daten = await res.json();
const preise = daten?.prices ?? [];
if (!preise.length) {
  console.error("Unerwartete Antwort: " + JSON.stringify(daten).slice(0, 200));
  process.exit(1);
}

// Ein Punkt je Tag, der frueheste. Der letzte Eintrag der Reihe ist der
// AKTUELLE Kurs und traegt das heutige Datum - er wuerde den Tageswert von
// 00:00 sonst ueberschreiben und die Reihe uneinheitlich machen.
const proTag = new Map();
for (const [ms, preis] of preise) {
  const tag = new Date(ms).toISOString().slice(0, 10);
  if (!proTag.has(tag)) proTag.set(tag, preis);
}
const zeilen = [...proTag.entries()].map(([day, preis]) => ({ day, preis }));

const spanne = zeilen[0].day + " bis " + zeilen[zeilen.length - 1].day;

if (lokal) {
  const { LocalDB } = await import("./local-db.mjs");
  const db = new LocalDB("./data/etn.db");
  const ins = db.prepare(
    "INSERT INTO price_history (day, preis) VALUES (?,?)" +
      " ON CONFLICT(day) DO UPDATE SET preis = excluded.preis"
  );
  for (const z of zeilen) await ins.bind(z.day, z.preis).run();
  db.close();
  console.error(zeilen.length + " Tageskurse in ./data/etn.db geschrieben (" + spanne + ")");
} else {
  // In Haeppchen, damit keine einzelne Anweisung ueberlang wird.
  const GROESSE = 60;
  for (let i = 0; i < zeilen.length; i += GROESSE) {
    const teil = zeilen.slice(i, i + GROESSE);
    console.log(
      "INSERT INTO price_history (day, preis) VALUES " +
        teil.map((z) => "('" + z.day + "'," + z.preis + ")").join(",") +
        " ON CONFLICT(day) DO UPDATE SET preis = excluded.preis;"
    );
  }
  console.error(zeilen.length + " Tageskurse als SQL ausgegeben (" + spanne + ")");
}
