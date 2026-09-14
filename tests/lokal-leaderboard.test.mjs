// Leaderboard gegen die lokale Datenbank: drei Zeitraeume je Zeile und der
// echte Rang bei Filtern. Ohne data/etn.db uebersprungen.
import { repoUrl, kopieDerLokalenDb, pruefer, ctx, BRIDGE, ohneZwischenspeicher } from "./hilfen.mjs";

const db = await kopieDerLokalenDb("leaderboard");
if (!db) {
  console.log("uebersprungen - keine lokale Datenbank in data/etn.db");
  process.exit(0);
}
const worker = (await import(repoUrl("src/index.js"))).default;
const { pruef, ende } = pruefer();
ohneZwischenspeicher();

const env = { DB: db, BRIDGE_ADDRESS: BRIDGE, MIGRATION_DEADLINE: "2027-01-31" };
const hol = async (q) => (await worker.fetch(new Request("http://localhost/api/leaderboard?" + q), env, ctx)).json();

async function komplett(zusatz) {
  const karte = new Map();
  for (let off = 0; ; off += 250) {
    const d = await hol("limit=250&offset=" + off + zusatz);
    for (const e of d.eintraege) karte.set(e.address, e.platz);
    if (off + 250 >= d.gesamt) return { karte, gesamt: d.gesamt };
  }
}

const erste = await hol("limit=50&offset=0");
pruef(erste.eintraege.length > 0 && erste.eintraege.every((e) =>
  ["d24h", "d7d", "d6m"].every((k) => e[k] && "delta_etn" in e[k] && "delta_sicher" in e[k])),
  "jede Zeile hat d24h, d7d und d6m");

const alle = await komplett("");
const echt = await komplett("&nur_wallets=1");
const dienste = await komplett("&nur_dienste=1");
pruef(Math.min(...echt.karte.values()) === 1, "nur echte Wallets beginnen bei Platz 1");
pruef(echt.karte.size === echt.gesamt, "nur echte: Gesamtzahl = gelieferte Zeilen");
pruef(dienste.karte.size === dienste.gesamt && dienste.gesamt > 0, "nur Dienste: Gesamtzahl = gelieferte Zeilen");
pruef(echt.karte.size + dienste.karte.size >= alle.karte.size, "echte + Dienste decken alle Wallets ab");

for (const [name, q, karte] of [
  ["500K-2M", "&min_etn=500000&max_etn=2000000&offset=0", alle.karte],
  ["500K-2M Seite 2", "&min_etn=500000&max_etn=2000000&offset=50", alle.karte],
  ["10M+", "&min_etn=10000000&offset=0", alle.karte],
  ["unter 400K Seite 3", "&max_etn=400000&offset=100", alle.karte],
  ["nur echte + 500K-2M", "&nur_wallets=1&min_etn=500000&max_etn=2000000&offset=0", echt.karte],
  ["Tier Octopus", "&tier=octopus&offset=0", alle.karte],
]) {
  const e = (await hol("limit=50" + q)).eintraege;
  pruef(e.length > 0 && e.every((x) => x.platz === karte.get(x.address)), name + ": jeder Platz = Platz in der Grundliste");
  pruef(e.every((x, i) => i === 0 || x.platz === e[i - 1].platz + 1), name + ": Plaetze lueckenlos");
  pruef(e.every((x) => !q.includes("min_etn=500000") || (x.etn >= 500000 && x.etn <= 2000000)), name + ": nur Bestaende im Bereich");
}

ende();
