// Census-Wallets: der woechentliche Census legt die Wallets unterhalb der
// Top N ab (src/census.js), das Leaderboard blaettert nach den Top N dort
// weiter (src/api/wallets.js, censusTeil). Der Explorer wird nachgebaut.
import { repoUrl, frischeDb, pruefer, ctx, BRIDGE, ohneZwischenspeicher } from "./hilfen.mjs";

const db = await frischeDb("census-wallets");
const { runCensus } = await import(repoUrl("src/census.js"));
const worker = (await import(repoUrl("src/index.js"))).default;
const { pruef, ende } = pruefer();
ohneZwischenspeicher();

const WEI = 10n ** 18n;
const adr = (i) => "0x" + i.toString(16).padStart(40, "0");
// 3 Wallets in den Top N, darunter 150 Census-Wallets von 400K abwaerts in
// 2.500er-Schritten bis 27.500, dann noch ein paar unter der Plankton-Grenze.
const top = [1_000_000, 800_000, 600_000];
const unten = Array.from({ length: 150 }, (_, i) => 400_000 - i * 2_500);
const rest = [20_000, 12_000, 4_000];
let explorer = [...top, ...unten, ...rest].map((etn, i) => ({ hash: adr(i + 1), etn }));
const CONTRACT = adr(4 + 20); // 350.000 ETN, ein Contract
const BOERSE = adr(4 + 40); // 300.000 ETN, als Boerse markiert

function seite(start) {
  const items = explorer.slice(start, start + 50).map((w) => ({
    hash: w.hash,
    coin_balance: String(BigInt(Math.round(w.etn)) * WEI),
    transaction_count: "5",
    is_contract: w.hash === CONTRACT,
    name: w.hash === CONTRACT ? "Vault" : null,
    ens_domain_name: w.hash === adr(10) ? "zehn.etn" : null,
  }));
  const next = start + 50 < explorer.length ? { items_count: start + 50 } : null;
  return { items, next_page_params: next, total_supply: "18000000000" };
}
const liveAbrufe = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const einzeln = u.pathname.match(/\/addresses\/(0x[0-9a-f]{40})$/);
  if (einzeln) {
    liveAbrufe.push(einzeln[1]);
    // Live hat jedes Wallet 1.234 ETN mehr als in der Census-Liste.
    const w = explorer.find((x) => x.hash === einzeln[1]);
    const etn = (w?.etn ?? 50_000) + 1_234;
    return new Response(JSON.stringify({ hash: einzeln[1], coin_balance: String(BigInt(etn) * WEI) }));
  }
  if (!u.pathname.endsWith("/addresses")) return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(seite(Number(u.searchParams.get("items_count") ?? 0))));
};

// Top N wie nach einem Snapshot
const jetzt = new Date().toISOString();
for (const [i, etn] of top.entries()) {
  db.db.prepare(
    "INSERT INTO current_balances (address, rank_pos, balance_wei, etn, tier, updated_at, in_top_n) VALUES (?,?,?,?,?,?,1)"
  ).run(adr(i + 1), i + 1, String(BigInt(etn) * WEI), etn, etn >= 1_000_000 ? "fish" : "octopus", jetzt);
}
db.db.prepare("INSERT INTO addresses (hash, first_seen, last_seen, label, label_type) VALUES (?,?,?,?,?)")
  .run(BOERSE, jetzt, jetzt, "Some Exchange", "exchange");

const env = { DB: db, BRIDGE_ADDRESS: BRIDGE, TRACK_TOP_N: "3", EXPLORER_API: "http://explorer.test/api/v2" };
const lauf1 = await runCensus(env, db, { depth: 1000 });
pruef(lauf1.wallets === 150, "150 Wallets unterhalb der Top N gespeichert (" + lauf1.wallets + ")");
const zeilen = db.db.prepare("SELECT COUNT(*) n, MIN(pos) a, MAX(pos) b, MIN(etn) m FROM census_wallets").get();
pruef(zeilen.n === 150 && zeilen.a === 1 && zeilen.b === 150, "Positionen 1 bis 150, keine Top-N-Wallets doppelt");
pruef(zeilen.m >= 25_000, "nichts unter der Plankton-Grenze");
const g = db.db.prepare("SELECT pos_unter, pos_bis FROM census_grenzen WHERE grenze = 100000").get();
pruef(g?.pos_unter === 122 && g?.pos_bis === 121, "Grenze 100K: ab Position 121 bis, ab 122 unter");

const hol = async (pfad) => (await worker.fetch(new Request("http://localhost" + pfad), env, ctx)).json();

// --- Blaettern ------------------------------------------------------------
const s1 = await hol("/api/leaderboard?limit=10&offset=0");
pruef(s1.gesamt === 153, "Gesamtzahl: 3 Top N + 150 Census (" + s1.gesamt + ")");
pruef(s1.eintraege.map((e) => e.platz).join() === "1,2,3,4,5,6,7,8,9,10", "Plaetze laufen ueber die Grenze hinweg weiter");
pruef(s1.eintraege[3].census === 1 && !s1.eintraege[2].census, "ab Platz 4 als Census-Zeile markiert");
pruef(s1.eintraege[3].etn === 400_000 && s1.eintraege[3].stand, "Census-Zeile mit Bestand und Stand");
pruef(s1.census_stand != null, "Zeitpunkt des Census wird mitgeliefert");

const s2 = await hol("/api/leaderboard?limit=10&offset=140");
pruef(s2.eintraege.length === 10 && s2.eintraege[0].platz === 141, "tiefe Seite beginnt bei Platz 141");
const s3 = await hol("/api/leaderboard?limit=10&offset=150");
pruef(s3.eintraege.length === 3 && s3.eintraege.at(-1).platz === 153, "letzte Seite endet bei Platz 153");

// --- Filter ---------------------------------------------------------------
const bereich = await hol("/api/leaderboard?limit=250&offset=0&min_etn=100000&max_etn=500000");
const imBereich = bereich.eintraege.every((e) => e.etn >= 100_000 && e.etn <= 500_000);
pruef(imBereich && bereich.eintraege.length === 121 && bereich.gesamt === 121, "100K-500K: genau die 121 Wallets im Bereich");
pruef(bereich.eintraege[0].platz === 4, "Rang im Bereich zaehlt die Top N mit");

const bis100 = await hol("/api/leaderboard?limit=250&offset=0&max_etn=100000");
pruef(bis100.eintraege.length === 30 && bis100.eintraege[0].etn === 100_000, "unter 100K: beginnt bei genau 100.000 (bis einschliesslich)");

const shrimp = await hol("/api/leaderboard?limit=250&offset=0&tier=shrimp");
pruef(shrimp.eintraege.length > 0 && shrimp.eintraege.every((e) => e.etn >= 100_000 && e.etn < 200_000), "Stufe Shrimp: nur 100K bis unter 200K");
pruef(shrimp.gesamt === shrimp.eintraege.length, "Stufe Shrimp: Zahl passt zur Liste");

const dienste = await hol("/api/leaderboard?limit=50&offset=0&nur_dienste=1");
const dAdr = dienste.eintraege.map((e) => e.address);
pruef(dAdr.includes(CONTRACT) && dAdr.includes(BOERSE) && dienste.gesamt === 2, "Services only: Contract und Boerse aus dem Census");

const echt = await hol("/api/leaderboard?limit=250&offset=0&nur_wallets=1");
pruef(!echt.eintraege.some((e) => e.address === CONTRACT || e.address === BOERSE), "Real wallets only: beide ausgeblendet");
pruef(echt.gesamt === 151, "Real wallets only: 153 - 2 (" + echt.gesamt + ")");
pruef(echt.eintraege.find((e) => e.address === adr(10))?.anzeige === "zehn.etn", ".etn-Name aus dem Census wird angezeigt");

// --- Aus den Top N gefallen ------------------------------------------------
db.db.prepare(
  "INSERT INTO census_wallets (address, pos, balance_wei, etn, gesehen) VALUES (?,?,?,?,?)"
).run(adr(999), 0, String(401_000n * WEI), 401_000, jetzt);
const mitAbgang = await hol("/api/leaderboard?limit=5&offset=3");
pruef(mitAbgang.eintraege[0].address === adr(999) && mitAbgang.eintraege[0].platz === 4, "gerade herausgefallenes Wallet steht oben in der Census-Liste");
const hoch = await hol("/api/leaderboard?limit=50&offset=0&min_etn=500000&max_etn=2000000");
pruef(!hoch.eintraege.some((e) => e.census), "500K-2M: keine Census-Zeilen, auch nicht das herausgefallene");
const bis100b = await hol("/api/leaderboard?limit=250&offset=0&max_etn=100000");
pruef(!bis100b.eintraege.some((e) => e.address === adr(999)), "unter 100K: herausgefallenes Wallet (401K) nicht dabei");
db.db.prepare("DELETE FROM census_wallets WHERE address = ?").run(adr(999));

// --- Zweiter Lauf: Veraenderungen ------------------------------------------
explorer = explorer.map((w) => (w.hash === adr(5) ? { ...w, etn: 399_000 } : w));
await runCensus(env, db, { depth: 1000 });
const w5 = db.db.prepare("SELECT etn, etn_vorher FROM census_wallets WHERE address = ?").get(adr(5));
pruef(w5.etn === 399_000 && w5.etn_vorher === 397_500, "Wochenveraenderung: Bestand und Vorwoche (" + JSON.stringify(w5) + ")");
const w6 = db.db.prepare("SELECT etn, etn_vorher FROM census_wallets WHERE address = ?").get(adr(6));
pruef(w6.etn_vorher === w6.etn, "unveraendertes Wallet: Vorwoche gleich Bestand");
const s4 = await hol("/api/leaderboard?limit=10&offset=0");
const z5 = s4.eintraege.find((e) => e.address === adr(5));
pruef(z5?.d7d?.delta_etn === 1_500, "Leaderboard zeigt die Wochenveraenderung (+1.500)");

// Ein Wallet waechst in die Top N: es darf nicht doppelt stehen.
explorer = explorer.filter((w) => w.hash !== adr(7));
await runCensus(env, db, { depth: 1000 });
pruef(!db.db.prepare("SELECT 1 FROM census_wallets WHERE address = ?").get(adr(7)), "nicht mehr gesehene Wallets fallen beim naechsten Census raus");

// --- Wallet-Seite und Refresh ----------------------------------------------
const ziel = adr(50); // 285.000 ETN im Census
const anfrage = (pfad, methode = "GET") => worker.fetch(new Request("http://localhost" + pfad, { method: methode }), env, ctx);

const profil = await (await anfrage("/api/search?q=" + ziel)).json();
pruef(profil.quelle === "census_live" && profil.etn === 286_234, "Census-Wallet oeffnen: Bestand live geholt");
pruef(profil.census_rang > 3 && profil.tier === "crab", "Rang aus dem Census und Tier sind dabei");
const nachher = db.db.prepare("SELECT etn, aktualisiert FROM census_wallets WHERE address = ?").get(ziel);
pruef(nachher.etn === 286_234 && nachher.aktualisiert, "frischer Bestand steht danach auch in der Liste");

const gleichDanach = await anfrage("/api/refresh/" + ziel, "POST");
const sperre = await gleichDanach.json();
pruef(gleichDanach.status === 429 && sperre.warten_s > 500, "Refresh direkt nach dem Oeffnen: gesperrt (" + sperre.warten_s + " s)");
pruef((await anfrage("/api/refresh/" + ziel)).status === 405, "Refresh nur per POST");
const vorKaputt = liveAbrufe.length;
const kaputt = await anfrage("/api/refresh/0x123", "POST");
pruef(kaputt.status === 404 && liveAbrufe.length === vorKaputt, "kaputte Adresse landet nicht beim Explorer");

db.db.prepare("UPDATE live_abrufe SET geholt_am = ? WHERE address = ?").run(new Date(Date.now() - 11 * 60000).toISOString(), ziel);
const abrufeVorher = liveAbrufe.length;
const frisch = await anfrage("/api/refresh/" + ziel, "POST");
const frischDaten = await frisch.json();
pruef(frisch.status === 200 && frischDaten.quelle === "census_live" && liveAbrufe.length === abrufeVorher + 1, "nach 10 Minuten: genau ein neuer Abruf");

// Minutenbudget aufgebraucht: Census-Wallet zeigt den Wochenstand, unbekanntes Wallet wartet.
db.db.prepare("INSERT INTO live_budget (ts, art, kosten) VALUES (?, 'test', 60)").run(new Date().toISOString());
const anderes = adr(60);
const ohneBudget = await (await anfrage("/api/search?q=" + anderes)).json();
pruef(ohneBudget.quelle === "census" && ohneBudget.stand && ohneBudget.etn === 260_000, "Budget leer: Census-Wallet mit Wochenstand und Datum");
const fremd = await anfrage("/api/search?q=" + adr(77777));
pruef(fremd.status === 429, "Budget leer: unbekanntes Wallet bekommt 'try again'");
db.db.prepare("UPDATE live_abrufe SET geholt_am = ? WHERE address = ?").run(new Date(Date.now() - 11 * 60000).toISOString(), ziel);
const refreshOhneBudget = await anfrage("/api/refresh/" + ziel, "POST");
pruef(refreshOhneBudget.status === 429, "Budget leer: auch Refresh wartet");

ende();
