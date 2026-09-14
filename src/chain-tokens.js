// Die Oekosystem-Tokens auf dem Chain-Reiter.
//
// Von MrDelayMK ausgewaehlt, Adressen und Trade-Links von ihm bestaetigt
// (14.09.2026). Fest ueber die Contract-Adresse, nie ueber Name oder Symbol:
// zu BOLT und DYNO gibt es Nachahmer mit gleichem Namen und Symbol.
//
// Eigene Datei, damit der Worker die Liste lesen kann, ohne den Explorer-Client
// aus src/blockscout.js mitzuladen.

export const CHAIN_TOKENS = [
  { address: "0x043fAa1b5C5FC9a7dc35171f290c29ECDE0cCff1", symbol: "BOLT", name: "ElectroSwap", logo: "bolt.svg" },
  { address: "0xEe432C220273e4F949007B4c1946562826Efa055", symbol: "DYNO", name: "Dynamo", logo: "dyno.svg" },
  { address: "0xC9FC4AB00911793D99b5c7Bd01f01203C21D4131", symbol: "CLUB", name: "ETN Club", logo: "club.png" },
  { address: "0xE74e4E7A064310466f3bdBd3F3Ce4e8c8F7CF1d5", symbol: "DCNT", name: "DECENTRONEUM", logo: "dcnt.png" },
  { address: "0x309B916b3A90cb3E071697Ea9680e9217A30066f", symbol: "CORE", name: "Planet Zephyros", logo: "core.png" },
];

/** Handelsseite des Tokens auf ElectroSwap - Format so von MrDelayMK vorgegeben. */
export const tradeLink = (address) =>
  "https://app.electroswap.io/explore/tokens/electroneum/" + String(address).toLowerCase() + "?inputCurrency=ETN";
