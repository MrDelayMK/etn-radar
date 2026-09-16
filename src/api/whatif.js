// What if: was ein ETN kostete, haette es die Marktkapitalisierung eines
// anderen Coins. Reine Division, keine Vorhersage.
//
// Die Coins kommen aus coin_caps - einmal taeglich vom Snapshot-Lauf gefuellt
// (src/marketcaps.js). Hier wird nichts nach draussen gefragt.

import { ETN_ID } from "../marketcaps.js";

// Stablecoins und verpackte Formen anderer Coins: "ETN mit der
// Marktkapitalisierung von Tether" ist zwar rechenbar, sagt aber nichts. Die
// Liste deckt die ueblichen Verdaechtigen der Top 300 ab und darf wachsen.
const RAUS = new Set([
  "tether", "usd-coin", "dai", "first-digital-usd", "ethena-usde", "usds", "sky-dollar",
  "binance-bridged-usdt-bnb-smart-chain", "paypal-usd", "true-usd", "frax", "blackrock-usd",
  "wrapped-bitcoin", "wrapped-steth", "staked-ether", "weth", "wrapped-eeth", "wrapped-beacon-eth",
  "coinbase-wrapped-btc", "binance-peg-weth", "bridged-wrapped-steth-scroll", "wbnb", "wrapped-avax",
  "solv-btc", "lombard-staked-btc", "jito-staked-sol", "binance-staked-sol", "mantle-staked-ether",
]);

// Schnellauswahl: je Bereich die bekanntesten Namen, damit man vom Riesen bis
// zum kleinen Coin die ganze Bandbreite sieht statt nur Traumzahlen. Gesucht
// wird in dieser Reihenfolge; fehlen bekannte Namen, fuellt der Rang auf.
const BEKANNT = [
  "bitcoin", "ethereum", "ripple", "solana", "dogecoin", "cardano", "tron", "chainlink",
  "avalanche-2", "stellar", "litecoin", "polkadot", "hedera-hashgraph", "bitcoin-cash",
  "shiba-inu", "uniswap", "monero", "ethereum-classic", "cosmos", "aptos", "filecoin",
  "algorand", "vechain", "tezos", "eos", "iota", "neo", "dash", "zcash", "ravencoin",
  "digibyte", "nano", "verge", "siacoin", "holotoken", "status",
];
const BEREICHE = [
  ["Top 10", 1, 10], ["Top 30", 11, 30], ["Top 50", 31, 50],
  ["Top 100", 51, 100], ["Top 150", 101, 150], ["Top 300", 151, 300],
];
const JE_BEREICH = 2;

export async function whatif(db, env) {
  const [snap, zeilen] = await Promise.all([
    db
      .prepare(
        "SELECT total_supply, bridge_wei, etn_price FROM snapshots" +
          " WHERE status='ok' ORDER BY id DESC LIMIT 1"
      )
      .first(),
    db
      .prepare("SELECT id, symbol, name, rang, market_cap, abgerufen FROM coin_caps ORDER BY rang")
      .all()
      .then((r) => r.results ?? [])
      .catch(() => []),
  ]);

  const gesamt = Number(snap?.total_supply ?? 0);
  const bridge = snap?.bridge_wei ? Number(BigInt(snap.bridge_wei) / 10n ** 12n) / 1e6 : 0;
  // ETN selbst ist kein Vergleichspartner - sein Rang steht beim ETN-Kaertchen.
  const etnZeile = zeilen.find((z) => z.id === ETN_ID);
  const coins = zeilen
    .filter((z) => z.id !== ETN_ID && !RAUS.has(z.id) && Number(z.market_cap) > 0)
    .map((z) => ({ i: z.id, s: z.symbol, n: z.name, r: z.rang, c: Number(z.market_cap) }));

  const schnell = [];
  for (const [titel, von, bis] of BEREICHE) {
    const drin = coins.filter((c) => c.r >= von && c.r <= bis);
    const bekannt = BEKANNT.map((id) => drin.find((c) => c.i === id)).filter(Boolean);
    const ids = [...bekannt, ...drin].map((c) => c.i).filter((id, i, a) => a.indexOf(id) === i);
    if (ids.length) schnell.push({ titel, ids: ids.slice(0, JE_BEREICH) });
  }

  return {
    etn: {
      preis: Number(snap?.etn_price ?? 0) || null,
      // Standard: die ganze Menge. Umschalter: nur, was die Bridge verlassen hat.
      gesamt,
      migriert: gesamt ? gesamt - bridge : 0,
      // Platz nach Marktkapitalisierung bei CoinGecko
      rang: etnZeile?.rang ?? null,
    },
    coins,
    schnell,
    stand: coins.length ? zeilen[0]?.abgerufen ?? null : null,
  };
}
