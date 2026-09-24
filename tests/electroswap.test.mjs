// ElectroSwap-Client (src/electroswap.js): Preise, Tokenliste und
// Wallet-Bestaende. Jeder Abruf kostet Credits, darum pruefen die Tests vor
// allem, WANN gefragt wird - und dass eine 429-Bremse respektiert wird.
// Die API wird nachgebaut, der Test fragt nie das echte Netz.
import { repoUrl, frischeDb, pruefer } from "./hilfen.mjs";

const db = await frischeDb("electroswap");
const { preiseAuffrischen, tokenListeAuffrischen, walletTokenWerte } = await import(repoUrl("src/electroswap.js"));
const { pruef, ende } = pruefer();

const BOLT = "0x043faa1b5c5fc9a7dc35171f290c29ecde0ccff1";
const DYNO = "0xee432c220273e4f949007b4c1946562826efa055";
const wallet = "0x79c0c8fe02b2438ea44d35cec24bf36e89d2704b";
const env = { ELECTROSWAP_API_KEY: "esk_live_test" };

const abrufe = [];
let antworten = {};
globalThis.fetch = async (url, opt) => {
  const u = String(url);
  abrufe.push({ u, auth: opt?.headers?.authorization });
  for (const [teil, machen] of Object.entries(antworten)) {
    if (u.includes(teil)) return machen();
  }
  return new Response("{}", { status: 404 });
};
const json = (daten, kosten = 150) =>
  new Response(JSON.stringify({ data: daten }), {
    headers: { "content-type": "application/json", "x-credits-cost": String(kosten) },
  });

antworten = {
  "/tokens/52014": () => json([
    { address: "0x043fAa1b5C5FC9a7dc35171f290c29ECDE0cCff1", name: "ElectroSwap", symbol: "BOLT", decimals: 18, totalSupply: 100000000 },
    { address: "0xEe432C220273e4F949007B4c1946562826Efa055", name: "Dynamo", symbol: "DYNO", decimals: 18, totalSupply: 23797 },
  ], 110),
  "/prices/52014": () => json({ [BOLT]: { usd: "0.005470448", etn: "2.7365" }, [DYNO]: { usd: "3.8543136", etn: "1928.12" } }),
  "/balances/52014": () => json({
    address: wallet,
    updated: 1788556430456,
    // 15.000.000 BOLT und 1 DYNO, genau wie die echte Antwort in Hex-Wei.
    balances: {
      "0x043fAa1b5C5FC9a7dc35171f290c29ECDE0cCff1": { balance: "0x0c685fa11e01ec6f000000", blockUpdated: 9926565 },
      "0xEe432C220273e4F949007B4c1946562826Efa055": { balance: "0x0de0b6b3a7640000", blockUpdated: 9966662 },
    },
  }, 820),
};

const jetzt = Date.parse("2026-09-23T20:00:00Z");
const p1 = await preiseAuffrischen(db, env, [BOLT, DYNO], jetzt);
pruef(p1.gefragt && p1.tokens === 2, "erster Preisabruf holt beide Tokens");
pruef(abrufe[0].auth === "Bearer esk_live_test", "der Schluessel geht als Bearer mit");
pruef(abrufe[0].u.startsWith("https://electroswap.io/public-api/v1/"), "nur die oeffentliche API, nie /graphql oder /api");

const p2 = await preiseAuffrischen(db, env, [BOLT, DYNO], jetzt + 12 * 3600000);
pruef(!p2.gefragt && abrufe.length === 1, "am selben Tag wird nicht erneut gefragt");
const p3 = await preiseAuffrischen(db, env, [BOLT, DYNO], jetzt + 25 * 3600000);
pruef(p3.gefragt && abrufe.length === 2, "eine Woche spaeter wieder");
// Ein fremdes Token ohne Preis muss einen Abruf ausloesen duerfen.
const p4 = await preiseAuffrischen(db, env, [BOLT, "0x" + "9".repeat(40)], jetzt + 25.1 * 3600000);
pruef(p4.gefragt && abrufe.length === 3, "fehlender Preis fragt sofort nach");

// Wallet-Bestand: Hex-Wei richtig umgerechnet und mit Preis bewertet.
const w = await walletTokenWerte(db, env, wallet, jetzt + 25.2 * 3600000);
const bolt = w.tokens.find((t) => t.address === BOLT);
const dyno = w.tokens.find((t) => t.address === DYNO);
pruef(Math.abs(bolt.menge - 15000000) < 1 && bolt.symbol === "BOLT", "15 Mio. BOLT mit Symbol");
pruef(Math.abs(dyno.menge - 1) < 1e-6, "1 DYNO aus 18 Dezimalstellen");
pruef(Math.abs(bolt.wert_usd - 15000000 * 0.005470448) < 1, "Wert = Menge mal Preis");
pruef(w.tokens[0].address === BOLT, "nach Wert sortiert, das groesste zuerst");
pruef(Math.abs(w.gesamt_usd - (bolt.wert_usd + dyno.wert_usd)) < 0.01, "Gesamtwert ist die Summe");

const zaehle = (teil) => abrufe.filter((a) => a.u.includes(teil)).length;
const vorher = zaehle("/balances/");
await walletTokenWerte(db, env, wallet, jetzt + 25.3 * 3600000);
pruef(zaehle("/balances/") === vorher, "innerhalb von 24 Stunden kein neuer Bestandsabruf");

// 429: die Pause wird gemerkt, danach fragt nichts mehr nach.
antworten["/prices/52014"] = () => new Response("{}", { status: 429, headers: { "retry-after": "120" } });
const fremd = "0x" + "a".repeat(40);
const p5 = await preiseAuffrischen(db, env, [fremd], jetzt + 50 * 3600000);
pruef(!p5.gefragt && p5.grund === "bremse", "429 wird als Bremse erkannt");
const nach429 = abrufe.length;
await preiseAuffrischen(db, env, [fremd], jetzt + 50.01 * 3600000);
pruef(abrufe.length === nach429, "waehrend der Pause geht keine Anfrage raus");

// Ohne Schluessel passiert gar nichts - die Seite darf trotzdem funktionieren.
const ohne = await walletTokenWerte(db, {}, "0x" + "b".repeat(40), jetzt);
pruef(ohne.tokens.length === 0 && ohne.gesamt_usd === 0, "ohne Schluessel leere Antwort statt Fehler");
const falsch = await walletTokenWerte(db, env, "0x123", jetzt);
pruef(falsch.status === 400, "ungueltige Adresse wird abgewiesen");

// Tokenliste: hoechstens einmal am Tag.
const listeVorher = zaehle("/tokens/52014");
await tokenListeAuffrischen(db, env, jetzt + 50.2 * 3600000);
pruef(zaehle("/tokens/52014") === listeVorher, "die Tokenliste wird nicht zweimal die Woche geholt");
const spaeter = await tokenListeAuffrischen(db, env, jetzt + 10 * 24 * 3600000);
pruef(spaeter.gefragt && zaehle("/tokens/52014") === listeVorher + 1, "eine Woche spaeter wieder");


// --- NFT: alle Sammlungen in EINEM Abruf (/nft/stats, 25 Credits) ----------
const { nftSammlungenAuffrischen, nftSammlungenLesen } = await import(repoUrl("src/electroswap.js"));
antworten["/nft/stats"] = () => json({
  updatedAt: "2026-09-23T20:53:55.378Z",
  collections: [
    { address: "0x0dD500d9eDEF4d0c4B0c50fa0C4faccB711FDA43", name: "ElectroPunks", symbol: "EPUNKS",
      image: "https://static.electroswap.io/images/ElectroPunk-Logo.gif", floorPrice: 1000, uniqueOwners: 66, listingCount: 19 },
    { address: "0x939548A645AD1C3164d82A168735DB1558c9EFDD", name: "Ohne Angebot", symbol: "ER",
      image: null, floorPrice: null, uniqueOwners: 110, listingCount: 0 },
  ],
}, 25);

const nftJetzt = jetzt + 100 * 3600000;
const n1 = await nftSammlungenAuffrischen(db, env, nftJetzt);
pruef(n1.gefragt && n1.sammlungen === 2 && n1.kosten === 25, "ein Abruf bringt alle Sammlungen fuer 25 Credits");
const vorherNft = zaehle("/nft/stats");
const n2 = await nftSammlungenAuffrischen(db, env, nftJetzt + 3 * 24 * 3600000);
pruef(!n2.gefragt && zaehle("/nft/stats") === vorherNft, "innerhalb der Woche kein zweiter Abruf");
const n3 = await nftSammlungenAuffrischen(db, env, nftJetzt + 8 * 24 * 3600000);
pruef(n3.gefragt, "nach einer Woche wieder");

const sammlungen = await nftSammlungenLesen(db);
pruef(sammlungen.length === 1 && sammlungen[0].symbol === "EPUNKS", "nur Sammlungen mit Bodenpreis");
pruef(sammlungen[0].bild?.endsWith(".gif") && sammlungen[0].angebote === 19, "Logo und Angebote kommen mit");

ende();
