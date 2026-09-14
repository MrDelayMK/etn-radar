// Explorer-Drossel gegen einen nachgebauten Explorer: Grundtempo, Obergrenze bei
// sofortiger und paralleler Antwort, Verlangsamung nach HTTP 429.
// Die Explorer-Last ist mit dem Betreiber abgesprochen (hoechstens 1,5/s) -
// dieser Test haelt fest, dass das auch so bleibt.
import { repoUrl, pruefer } from "./hilfen.mjs";

const { fetchAddress, drosselStatus } = await import(repoUrl("src/blockscout.js"));
const { pruef, ende } = pruefer();

let starts = [];
let antwortMs = 0;
let bremsen = 0; // so viele der naechsten Anfragen bekommen 429
globalThis.fetch = async () => {
  starts.push(Date.now());
  if (antwortMs) await new Promise((r) => setTimeout(r, antwortMs));
  if (bremsen > 0) {
    bremsen--;
    return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
  }
  return new Response(JSON.stringify({ hash: "0x1", coin_balance: "1000000000000000000" }),
    { headers: { "content-type": "application/json" } });
};

function auswerten(name) {
  const abst = starts.slice(1).map((t, i) => t - starts[i]);
  const min = Math.min(...abst);
  const rate = (starts.length - 1) / ((starts[starts.length - 1] - starts[0]) / 1000);
  console.log("  " + name + ": " + starts.length + " Anfragen, kleinster Abstand " + min + " ms, " + rate.toFixed(2) + "/s");
  return { min, rate, abst };
}

antwortMs = 370; starts = [];
for (let i = 0; i < 8; i++) await fetchAddress("https://fake.test/api/v2", "0x1");
const a = auswerten("nacheinander, 370 ms Antwort");
pruef(a.min >= 668 && a.rate <= 1.5, "hoechstens 1,5/s bei normaler Antwortzeit");

antwortMs = 0; starts = [];
for (let i = 0; i < 8; i++) await fetchAddress("https://fake.test/api/v2", "0x1");
const b = auswerten("nacheinander, sofortige Antwort");
pruef(b.min >= 668 && b.rate <= 1.5, "hoechstens 1,5/s auch bei sofortiger Antwort");

antwortMs = 20; starts = [];
await Promise.all(Array.from({ length: 8 }, () => fetchAddress("https://fake.test/api/v2", "0x1")));
const c = auswerten("8 parallel");
pruef(c.min >= 668 && c.rate <= 1.5, "parallel ebenfalls hoechstens 1,5/s");

// 429: eine Anfrage wird gebremst, danach muss der Abstand laenger sein.
antwortMs = 0; starts = []; bremsen = 1;
for (let i = 0; i < 4; i++) await fetchAddress("https://fake.test/api/v2", "0x1");
const d = auswerten("nach einem 429");
const s = drosselStatus();
pruef(s.gedrosselt === 1 && s.abstand_ms === 1005, "Abstand nach einem 429 auf 1.005 ms verlaengert");
pruef(d.abst.slice(1).every((x) => x >= 1003), "folgende Anfragen halten den laengeren Abstand");

ende();
