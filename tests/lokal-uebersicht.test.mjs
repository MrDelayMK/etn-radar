// Uebersicht gegen die lokale Datenbank: Leaderboard-Zaehler aus dem
// Kennzahlen-Block, Spendenadresse, Kursverlauf und die 7-Tage-Veraenderung je
// Tier. Ohne data/etn.db uebersprungen.
import { repoUrl, kopieDerLokalenDb, pruefer, ctx, BRIDGE, ohneZwischenspeicher } from "./hilfen.mjs";

const db = await kopieDerLokalenDb("uebersicht");
if (!db) {
  console.log("uebersprungen - keine lokale Datenbank in data/etn.db");
  process.exit(0);
}
const worker = (await import(repoUrl("src/index.js"))).default;
const { pruef, ende } = pruefer();
ohneZwischenspeicher();
globalThis.fetch = async () => new Response("{}", { status: 503 });

const env = {
  DB: db, BRIDGE_ADDRESS: BRIDGE, TRACK_TOP_N: "3000", MIGRATION_DEADLINE: "2027-01-31",
  EXPLORER_API: "http://127.0.0.1:9", DONATE_ADDRESS: "0x1111111111111111111111111111111111111111",
};
const hol = async (pfad, e = env) => {
  const r = await worker.fetch(new Request("http://localhost" + pfad), e, ctx);
  return { status: r.status, daten: r.status === 200 ? await r.json() : null };
};
const tagVor = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// --- Leaderboard-Zaehler ----------------------------------------------------
const direkt = db.db.prepare("SELECT count(*) n FROM current_balances WHERE in_top_n=1 AND address != lower(?)").get(BRIDGE).n;
db.db.prepare("DELETE FROM kennzahlen").run();
const ohne = await hol("/api/leaderboard?limit=5&offset=0");
pruef(ohne.daten?.gesamt === direkt, "Zaehler ohne Kennzahlen faellt auf die Zaehlung zurueck");
db.db.prepare("INSERT INTO kennzahlen (id, daten, snapshot_id, erstellt_am) VALUES (1, ?, 1, ?)")
  .run(JSON.stringify({ holder_anzahl: 4242 }), new Date().toISOString());
pruef((await hol("/api/leaderboard?limit=5&offset=0")).daten?.gesamt === 4242, "Zaehler mit Kennzahlen kommt aus dem Block");

// --- Spendenadresse -----------------------------------------------------------
pruef((await hol("/api/overview")).daten?.spenden_adresse === env.DONATE_ADDRESS, "gueltige Spendenadresse wird ausgeliefert");
pruef((await hol("/api/overview", { ...env, DONATE_ADDRESS: "0x123" })).daten?.spenden_adresse === null, "ungueltige Adresse nicht");
pruef((await hol("/api/overview", { ...env, DONATE_ADDRESS: "" })).daten?.spenden_adresse === null, "ohne Adresse bleibt das Feld leer");

// --- Kursverlauf und entfernte Endpunkte -------------------------------------
pruef(((await hol("/api/price?period=30d")).daten?.punkte ?? []).length > 0, "Kursverlauf liefert Punkte");
pruef((await hol("/api/tiers")).status === 404, "/api/tiers bleibt entfernt");

// --- 7-Tage-Veraenderung je Tier ---------------------------------------------
db.db.exec("DELETE FROM tier_tage");
db.db.exec("DELETE FROM tier_census WHERE day < (SELECT max(day) FROM tier_census)");
const o1 = (await hol("/api/overview")).daten;
pruef(Array.isArray(o1.tiers) && o1.tiers.length > 0, "Uebersicht liefert Tiers");
pruef(o1.tiers.every((t) => t.aenderung_7d == null), "ohne Vergleichsdaten keine Veraenderung");

const jetzt = Object.fromEntries(o1.tiers.map((t) => [t.key, t.anzahl]));
const vorher = { humpback: jetzt.humpback, whale: (jetzt.whale ?? 0) + 3, shark: Math.max(1, (jetzt.shark ?? 0) - 5) };
for (const [tier, count] of Object.entries(vorher)) {
  db.db.prepare("INSERT INTO tier_tage (day, tier, count) VALUES (?,?,?)").run(tagVor(8), tier, count);
}
db.db.prepare("INSERT INTO tier_tage (day, tier, count) VALUES (?,?,?)").run(tagVor(12), "dolphin", 1);

const t2 = Object.fromEntries((await hol("/api/overview")).daten.tiers.map((t) => [t.key, t]));
pruef(t2.humpback.aenderung_7d === 0, "gleiche Zahl -> 0 %");
pruef(Math.abs(t2.whale.aenderung_7d - ((jetzt.whale - vorher.whale) / vorher.whale) * 100) < 1e-9, "Whale richtig gerechnet");
pruef(t2.shark.aenderung_7d > 0 && t2.shark.vergleich_tag === tagVor(8), "Shark gestiegen, Vergleichstag = vor 8 Tagen");
pruef(t2.dolphin.aenderung_7d == null, "ein 12 Tage alter Stand zaehlt nicht");
pruef(t2.dust.aenderung_7d == null, "Dust ohne Veraenderung");

ende();
