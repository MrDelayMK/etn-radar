// Tagessummen der Bridge gegen eine direkte Auszaehlung - ueber beliebige
// Haeppchengrenzen, mit einem Absturz zwischen Tagessumme und Cursor, und mit
// dem spaeteren Blick nach oben. Reine Funktionen, keine Datenbank.
import { repoUrl, pruefer } from "./hilfen.mjs";

const { haeppchenFalten, obenFalten, uebertragText, uebertragLesen, tagVon } =
  await import(repoUrl("src/bridge-tage.js"));
const { pruef, ende } = pruefer();

const BRIDGE = "0xbridge";
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// Kuenstliche Historie: 75 Tage, leere Tage dazwischen, ein paar Zufluesse,
// ein Transfer genau um Mitternacht.
const alle = [];
for (let d = 0; d < 75; d++) {
  const day = new Date(Date.UTC(2024, 2, 3) + d * 86400000).toISOString().slice(0, 10);
  const n = d % 7 === 3 ? 0 : Math.floor(rnd() * 40);
  for (let k = 0; k < n; k++) {
    const sek = d === 10 && k === 0 ? 0 : Math.floor(rnd() * 86400);
    const zeit = day + "T" + new Date(sek * 1000).toISOString().slice(11, 19) + ".000000Z";
    const rein = rnd() < 0.03;
    alle.push({
      timestamp: zeit,
      from: rein ? "0xjemand" : BRIDGE,
      to: rein ? BRIDGE : "0xempf" + k,
      value_wei: String(BigInt(1 + Math.floor(rnd() * 5e6)) * 10n ** 15n),
    });
  }
}
alle.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)); // neueste zuerst, wie der Explorer

function soll(liste) {
  const m = new Map();
  for (const t of liste) {
    const day = tagVon(t.timestamp);
    const e = m.get(day) ?? { abfluss_wei: 0n, abfluss_anzahl: 0, zufluss_wei: 0n };
    if (t.from === BRIDGE) { e.abfluss_wei += BigInt(t.value_wei); e.abfluss_anzahl++; }
    else e.zufluss_wei += BigInt(t.value_wei);
    m.set(day, e);
  }
  return m;
}

function gleich(ist, erwartet) {
  for (const [day, e] of erwartet) {
    const i = ist.get(day);
    if (!i || i.abfluss_wei !== e.abfluss_wei || i.abfluss_anzahl !== e.abfluss_anzahl || i.zufluss_wei !== e.zufluss_wei) return false;
  }
  return [...ist.keys()].every((day) => erwartet.has(day));
}

/** Rueckwaertsdurchgang in Haeppchen, Uebertrag laeuft durch JSON wie in bridge_scan. */
function durchgang(liste, groessen, absturzNach) {
  const tabelle = new Map();
  let uebertrag = null;
  let pos = 0;
  let nr = 0;
  while (pos < liste.length) {
    const g = groessen[nr % groessen.length];
    nr++;
    const stueck = liste.slice(pos, pos + g);
    const letztes = pos + g >= liste.length;
    const f = haeppchenFalten(stueck, BRIDGE, uebertrag, letztes);
    for (const t of f.fertig) tabelle.set(t.day, t);
    if (nr === absturzNach) {
      // Absturz nach den Tagessummen, vor dem Cursor: der naechste Lauf liest
      // dasselbe Stueck mit dem ALTEN Uebertrag noch einmal.
      const nochmal = haeppchenFalten(stueck, BRIDGE, uebertrag, letztes);
      for (const t of nochmal.fertig) tabelle.set(t.day, t);
    }
    uebertrag = uebertragLesen(uebertragText(f.uebertrag));
    pos += g;
  }
  return tabelle;
}

const erwartet = soll(alle);
console.log("Historie:", alle.length, "Transfers an", erwartet.size, "Tagen");

for (const [name, groessen] of [
  ["ein Transfer je Haeppchen", [1]],
  ["50er-Haeppchen", [50]],
  ["wechselnde Groessen", [7, 13, 200]],
  ["alles in einem Haeppchen", [alle.length]],
  ["winzig und riesig", [3, 1000]],
]) {
  pruef(gleich(durchgang(alle, groessen), erwartet), name);
}
pruef(gleich(durchgang(alle, [37], 4), erwartet), "Absturz zwischen Tagessumme und Cursor zaehlt nichts doppelt");

// Blick nach oben: erster Lauf sieht nur die aeltere Haelfte, danach kommt
// neuer Verkehr dazu und wird ab dem Anfang des letzten bekannten Tages neu
// ausgezaehlt.
const alt = alle.slice(Math.floor(alle.length / 2));
const tabelle = durchgang(alt, [29]);
const abTag = tagVon(alt[0].timestamp);
const bis = alle.findIndex((t) => tagVon(t.timestamp) < abTag);
for (const t of obenFalten(alle.slice(0, bis + 12), BRIDGE, abTag, true)) tabelle.set(t.day, t);
pruef(gleich(tabelle, erwartet), "Blick nach oben zaehlt den angebrochenen Tag neu aus");

// Gedeckelter Blick nach oben: der aelteste gelesene Tag darf nicht geschrieben werden.
const gedeckelt = obenFalten(alle.slice(0, 40), BRIDGE, "2000-01-01", false);
pruef(!gedeckelt.some((t) => t.day === tagVon(alle[39].timestamp)), "gedeckelter Blick laesst den angebrochenen Tag aus");

ende();
