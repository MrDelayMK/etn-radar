// Tier-System.
//
// Schwellen sind bewusst FIX IN ETN, nicht in USD: sonst wuerde ein Wallet bei
// fallendem Kurs absteigen, ohne je einen Coin bewegt zu haben.
//
// Acht Stufen entsprechen der in der ETN-Community gebraeuchlichen Einteilung.
// Ergaenzt ist einer bei 25 Mio (siehe unten) sowie drei Stufen ganz unten, die
// erst mit der woechentlichen Tiefenzaehlung (scripts/census*.mjs) entstehen.
//
// ---------------------------------------------------------------------------
// Zwei Geschwindigkeiten
// ---------------------------------------------------------------------------
// Wallets im Wert von ein paar Cent muessen nicht alle 6 Stunden verfolgt
// werden - das kostet nur unnoetig API-Anfragen und Speicher, ohne dass sich
// die Zahl je sichtbar aendert. Deshalb sind die Stufen in zwei Gruppen
// geteilt (Feld `census`):
//
//   census: false  Teil des normalen 6h-Snapshots (bis Octopus, >= 500k ETN).
//                   Einzeln gespeichert, mit vollem Verlauf, im Leaderboard
//                   durchblaetterbar.
//   census: true   Nur die woechentliche Tiefenzaehlung erfasst diese Stufen
//                   ueberhaupt. Es wird NUR die Anzahl/Summe gespeichert, keine
//                   einzelnen Wallet-Zeilen - bei 150.000+ Kleinstwallets waere
//                   das reiner Ballast. Einzelne Adressen bleiben trotzdem ueber
//                   die Wallet-Suche nachschlagbar (Live-Fallback zum Explorer).
//
// Der Schnitt bei Octopus (500k ETN, ~2.000 Wallets) ist eine Entscheidung
// darueber, wo Whale-Watching aufhoert sinnvoll zu sein - nicht eine
// Kostenfrage, beide Tiefen sind fuer sich genommen guenstig abzufragen.
//
// ---------------------------------------------------------------------------
// Der Schnitt bei 25 Mio (Humpback/Whale)
// ---------------------------------------------------------------------------
// Alle Stufen sind rund Faktor 2 bis 2,5 breit - nur Whale war mit 10 bis
// 100 Mio zehnmal so breit. Der Schnitt bei 25 Mio ergibt Faktor 2,5, genau
// wie Dolphin und Crab, und teilt die 80 Wallets in 24 und 56.
//
// Gemessene Besetzung oberhalb 100k (02.09.2026, ohne Bridge, Top 10.000):
//   Humpback >= 25 Mio :  24      Crab     >= 200k :   2.301
//   Whale    >= 10 Mio :  56      Shrimp   >= 100k :   4.270
//   Shark    >=  5 Mio :  86
//   Dolphin  >=  2 Mio : 330
//   Fish     >=  1 Mio : 635
//   Octopus  >=   500k : 915
//
// Die drei untersten Stufen (Plankton/Microbe/Dust) kommen aus der
// Tiefenzaehlung; Dust wird nie einzeln gezaehlt, sondern als Rest aus der
// Gesamtzahl der Chain-Adressen berechnet (total_addresses minus alles
// nachweislich Darueberliegende) - exakt wie zuvor bei Plankton, nur eine
// Stufe tiefer angesetzt.

export const CENSUS_DUST_FLOOR = 5_000; // unterhalb: nur noch Restrechnung

export const TIERS = [
  { key: "humpback", name: "Humpback Whale", emoji: "\u{1F40B}", min: 25_000_000, census: false },
  { key: "whale",    name: "Whale",          emoji: "\u{1F433}", min: 10_000_000, census: false },
  { key: "shark",    name: "Shark",          emoji: "\u{1F988}", min:  5_000_000, census: false },
  { key: "dolphin",  name: "Dolphin",        emoji: "\u{1F42C}", min:  2_000_000, census: false },
  { key: "fish",     name: "Fish",           emoji: "\u{1F41F}", min:  1_000_000, census: false },
  { key: "octopus",  name: "Octopus",        emoji: "\u{1F419}", min:    500_000, census: false },
  { key: "crab",     name: "Crab",           emoji: "\u{1F980}", min:    200_000, census: true },
  { key: "shrimp",   name: "Shrimp",         emoji: "\u{1F990}", min:    100_000, census: true },
  { key: "plankton", name: "Plankton",       emoji: "\u{1F9A0}", min:     25_000, census: true },
  { key: "microbe",  name: "Microbe",        emoji: "\u{1F9EB}", min:      5_000, census: true },
  { key: "dust",     name: "Dust",           emoji: "\u{1F4A8}", min:           0, census: true },
];

// Tiefste Stufe, die noch Teil des normalen 6h-Snapshots ist.
export const FAST_TIER_MIN = TIERS.find((t) => !t.census).min ?? 0;

/** Tier zu einem ETN-Betrag. */
export function tierFor(etn) {
  const v = Number(etn) || 0;
  for (const t of TIERS) if (v >= t.min) return t;
  return TIERS[TIERS.length - 1];
}

/** Rang des Tiers (0 = hoechste Stufe). Kleiner ist besser. */
export const tierIndex = (key) => TIERS.findIndex((t) => t.key === key);

/** Obergrenze eines Tiers (die Untergrenze der naechsthoeheren Stufe). */
export function tierMax(key) {
  const i = tierIndex(key);
  return i > 0 ? TIERS[i - 1].min : null;
}

/**
 * Fortschritt innerhalb des Tiers und Distanz zur naechsten Stufe.
 *
 * Das ist der Motor des Gamification-Features: die Zahl "noch X ETN bis Shark"
 * ist der Grund, warum jemand die Seite ein zweites Mal oeffnet. Funktioniert
 * fuer JEDE Adresse, auch tief unten in den census-only-Stufen - dafuer reicht
 * ein Zahlenvergleich, unabhaengig davon, ob die Stufe insgesamt gezaehlt wird.
 */
export function tierProgress(etn) {
  const v = Number(etn) || 0;
  const cur = tierFor(v);
  const idx = tierIndex(cur.key);
  const next = idx > 0 ? TIERS[idx - 1] : null;

  if (!next) return { tier: cur, next: null, needed: 0, progress: 1, isTop: true };

  const span = next.min - cur.min;
  const done = v - cur.min;
  return {
    tier: cur,
    next,
    needed: next.min - v,
    progress: span > 0 ? Math.min(1, Math.max(0, done / span)) : 0,
    isTop: false,
  };
}
