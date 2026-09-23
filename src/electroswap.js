// ElectroSwap Public API: Tokenpreise und Wallet-Tokenbestaende.
//
// Kosten je Abruf in Credits (1.000.000 Credits = 1 USD, siehe
// https://electroswap.io/docs/api/credits-and-pricing):
//
//   /prices/52014?addresses=..   100 + 10 je Token   -> 150 fuer unsere fuenf
//   /tokens/52014                100 +  5 je Token   -> Namen und Dezimalstellen
//   /balances/52014/<addr>       800 + 10 je Token   -> nur beim Oeffnen eines Wallets
//
// Darum: Preise hoechstens stuendlich und nur, wenn jemand die Seite ansieht
// (kein Zeitplan, keine Besucher = keine Abrufe). Bestaende je Wallet
// hoechstens alle zwoelf Stunden. Beides liegt zwischendurch in D1.
//
// Die privaten Endpunkte (/graphql, /api/) sind laut Doku tabu - wir fragen
// ausschliesslich /public-api/v1.

import { CHAIN_TOKENS } from "./chain-tokens.js";
import { pruefsummenAdresse } from "./keccak.js";

const BASIS = "https://electroswap.io/public-api/v1";
const KETTE = 52014; // Electroneum Mainnet, der einzige erlaubte Wert
export const PREIS_TAKT_MS = 60 * 60000;
export const BESTAND_TAKT_MS = 12 * 3600000;
// Ein 429 mit Retry-After muss respektiert werden: zwanzig Abfuhren in einer
// Minute sperren den Schluessel eine Viertelstunde.
const SPERRE_SCHLUESSEL = "electroswap_pause";

async function holen(env, pfad) {
  const schluessel = env.ELECTROSWAP_API_KEY;
  if (!schluessel) return { fehler: "kein_schluessel" };
  const antwort = await fetch(BASIS + pfad, {
    headers: { authorization: "Bearer " + schluessel, "user-agent": "etn-radar" },
  });
  if (antwort.status === 429 || antwort.status === 503) {
    const warten = Number(antwort.headers.get("retry-after")) || 60;
    return { fehler: "bremse", warten };
  }
  if (!antwort.ok) {
    const text = await antwort.text().catch(() => "");
    return { fehler: (JSON.parse(text || "{}")?.error?.code) ?? "http_" + antwort.status };
  }
  const daten = await antwort.json();
  return { daten: daten.data, kosten: Number(antwort.headers.get("x-credits-cost")) || 0 };
}

/** Wann darf fruehestens wieder gefragt werden? Merkt sich eine Bremse in D1. */
async function pause(db, jetzt) {
  const r = await db.prepare("SELECT wert FROM electroswap_status WHERE schluessel = ?").bind(SPERRE_SCHLUESSEL)
    .first().catch(() => null);
  return r?.wert && Number(r.wert) > jetzt;
}
const pauseSetzen = (db, bis) =>
  db.prepare("INSERT INTO electroswap_status (schluessel, wert) VALUES (?,?) ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert")
    .bind(SPERRE_SCHLUESSEL, String(bis)).run().catch(() => {});

/**
 * Preise der verfolgten Tokens auffrischen, wenn sie aelter als eine Stunde
 * sind. Gibt zurueck, ob wirklich gefragt wurde - der Aufrufer haengt das an
 * ctx.waitUntil, die Seite wartet also nie darauf.
 */
export async function preiseAuffrischen(db, env, adressen, jetzt = Date.now()) {
  if (!adressen.length || !env.ELECTROSWAP_API_KEY) return { gefragt: false };
  if (await pause(db, jetzt)) return { gefragt: false, grund: "bremse" };
  // Gefragt wird nur, wenn einer der gewuenschten Preise fehlt oder alt ist -
  // sonst holte ein Wallet mit unbekanntem Token nie seinen Preis.
  const platz = adressen.map(() => "?").join(",");
  const stand = await db
    .prepare("SELECT count(*) n, min(aktualisiert) t FROM token_preise WHERE address IN (" + platz + ") AND preis_usd > 0")
    .bind(...adressen.map((a) => a.toLowerCase()))
    .first()
    .catch(() => null);
  const vollstaendig = (stand?.n ?? 0) >= adressen.length;
  if (vollstaendig && stand?.t && jetzt - Date.parse(stand.t) < PREIS_TAKT_MS) return { gefragt: false, grund: "frisch" };

  // Hoechstens 50 Adressen je Abruf, abgerechnet wird nach zurueckgegebenen Posten.
  const liste = adressen.slice(0, 50).map((a) => a.toLowerCase()).join(",");
  const r = await holen(env, "/prices/" + KETTE + "?addresses=" + liste);
  if (r.fehler === "bremse") {
    await pauseSetzen(db, jetzt + r.warten * 1000);
    return { gefragt: false, grund: "bremse" };
  }
  if (r.fehler || !r.daten) return { gefragt: false, grund: r.fehler ?? "leer" };

  const zeit = new Date(jetzt).toISOString();
  const zeilen = Object.entries(r.daten)
    .filter(([, p]) => Number(p?.usd) > 0)
    .map(([adresse, p]) =>
      db.prepare(
        "INSERT INTO token_preise (address, preis_usd, preis_etn, aktualisiert) VALUES (?,?,?,?)" +
          " ON CONFLICT(address) DO UPDATE SET preis_usd = excluded.preis_usd," +
          " preis_etn = excluded.preis_etn, aktualisiert = excluded.aktualisiert"
      ).bind(adresse.toLowerCase(), Number(p.usd), Number(p.etn), zeit)
    );
  if (zeilen.length) await db.batch(zeilen);
  return { gefragt: true, tokens: zeilen.length, kosten: r.kosten };
}

/**
 * Namen, Symbole und Dezimalstellen aller gelisteten Tokens - hoechstens
 * einmal am Tag. Ohne sie waere ein Wallet-Bestand nur eine Adresse mit einer
 * Zahl, und ohne decimals waere die Zahl sogar falsch.
 */
export async function tokenListeAuffrischen(db, env, jetzt = Date.now()) {
  if (!env.ELECTROSWAP_API_KEY || (await pause(db, jetzt))) return { gefragt: false };
  const stand = await db.prepare("SELECT wert FROM electroswap_status WHERE schluessel = 'tokenliste'")
    .first().catch(() => null);
  if (stand?.wert && jetzt - Number(stand.wert) < 24 * 3600000) return { gefragt: false, grund: "frisch" };
  const r = await holen(env, "/tokens/" + KETTE + "?limit=100");
  if (r.fehler === "bremse") {
    await pauseSetzen(db, jetzt + r.warten * 1000);
    return { gefragt: false, grund: "bremse" };
  }
  if (r.fehler || !Array.isArray(r.daten)) return { gefragt: false, grund: r.fehler ?? "leer" };
  const zeilen = r.daten.map((t) =>
    db.prepare(
      "INSERT INTO token_preise (address, symbol, name, decimals, total_supply) VALUES (?,?,?,?,?)" +
        " ON CONFLICT(address) DO UPDATE SET symbol = excluded.symbol, name = excluded.name," +
        " decimals = excluded.decimals, total_supply = excluded.total_supply"
    ).bind(String(t.address).toLowerCase(), t.symbol ?? null, t.name ?? null, Number(t.decimals ?? 18), Number(t.totalSupply ?? 0) || null)
  );
  zeilen.push(
    db.prepare("INSERT INTO electroswap_status (schluessel, wert) VALUES ('tokenliste', ?)" +
      " ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert").bind(String(jetzt))
  );
  await db.batch(zeilen);
  return { gefragt: true, tokens: r.daten.length, kosten: r.kosten };
}

/** Alle gespeicherten Preise als Map Adresse (klein) -> { usd, etn, stand }. */
export async function preiseLesen(db) {
  const rows = (await db.prepare(
    "SELECT address, symbol, name, decimals, preis_usd, preis_etn, aktualisiert FROM token_preise"
  ).all().catch(() => ({ results: [] }))).results ?? [];
  return new Map(rows.map((r) => [r.address, {
    symbol: r.symbol, name: r.name, decimals: r.decimals ?? 18,
    usd: r.preis_usd, etn: r.preis_etn, stand: r.aktualisiert,
  }]));
}

/**
 * Tokenbestand eines Wallets. ElectroSwap fuehrt dafuer ein gespeichertes
 * Dokument ("no refresh") - Wallets, die dort nie auftauchten, kommen leer
 * zurueck. Das ist kein Fehler, sondern heisst schlicht: keine Tokens bekannt.
 */
export async function walletTokens(db, env, adresse, jetzt = Date.now()) {
  const adr = String(adresse).toLowerCase();
  const stand = await db.prepare("SELECT max(gesehen) t FROM wallet_tokens WHERE address = ?").bind(adr)
    .first().catch(() => null);
  const frisch = stand?.t && jetzt - Date.parse(stand.t) < BESTAND_TAKT_MS;
  if (!frisch && env.ELECTROSWAP_API_KEY && !(await pause(db, jetzt))) {
    // Immer in der Pruefsummen-Schreibweise fragen (EIP-55): klein geschrieben
    // liefert ElectroSwap ein leeres Bestandsdokument statt der Tokens.
    const r = await holen(env, "/balances/" + KETTE + "/" + pruefsummenAdresse(adr) + "?limit=200");
    if (r.fehler === "bremse") await pauseSetzen(db, jetzt + r.warten * 1000);
    else if (r.daten) {
      const zeit = new Date(jetzt).toISOString();
      const eintraege = Object.entries(r.daten.balances ?? {});
      const zeilen = [db.prepare("DELETE FROM wallet_tokens WHERE address = ?").bind(adr)];
      for (const [token, b] of eintraege) {
        const wei = BigInt(b?.balance ?? "0x0");
        if (wei <= 0n) continue;
        zeilen.push(
          db.prepare("INSERT INTO wallet_tokens (address, token, menge_wei, gesehen) VALUES (?,?,?,?)")
            .bind(adr, token.toLowerCase(), wei.toString(), zeit)
        );
      }
      // Auch ein leeres Ergebnis wird vermerkt, sonst fragt jeder Aufruf neu.
      zeilen.push(
        db.prepare("INSERT INTO wallet_tokens (address, token, menge_wei, gesehen) VALUES (?, '-', '0', ?)" +
          " ON CONFLICT(address, token) DO UPDATE SET gesehen = excluded.gesehen").bind(adr, zeit)
      );
      await db.batch(zeilen).catch(() => {});
    }
  }
  const rows = (await db.prepare("SELECT token, menge_wei, gesehen FROM wallet_tokens WHERE address = ? AND token != '-'")
    .bind(adr).all().catch(() => ({ results: [] }))).results ?? [];
  return { tokens: rows, stand: stand?.t ?? null };
}

/**
 * Antwort fuer /api/wallet-tokens/<adresse>: Bestand mal Preis, absteigend
 * nach Wert. Beim ersten Oeffnen kostet das einen Abruf (rund 850 Credits),
 * danach zwoelf Stunden lang nichts mehr.
 */
export async function walletTokenWerte(db, env, adresse, jetzt = Date.now()) {
  const adr = String(adresse ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(adr)) return { error: "Keine gueltige Adresse", status: 400 };
  await tokenListeAuffrischen(db, env, jetzt).catch(() => {});
  const { tokens, stand } = await walletTokens(db, env, adr, jetzt);
  // Preise fuer genau die Tokens dieses Wallets plus die verfolgten - ein
  // Sammelabruf, hoechstens stuendlich.
  const gebraucht = [...new Set([...CHAIN_TOKENS.map((t) => t.address.toLowerCase()), ...tokens.map((t) => t.token)])];
  await preiseAuffrischen(db, env, gebraucht, jetzt).catch(() => {});
  const preise = await preiseLesen(db);
  const liste = tokens.map((t) => {
    const p = preise.get(t.token);
    const meta = p ?? {};
    const dezimal = Number(meta.decimals ?? 18);
    const menge = Number(BigInt(t.menge_wei) / 10n ** BigInt(Math.max(0, dezimal - 6))) / 1e6;
    return {
      address: t.token,
      symbol: meta.symbol ?? null,
      name: meta.name ?? null,
      menge,
      preis_usd: meta.usd ?? null,
      wert_usd: meta.usd ? menge * meta.usd : null,
    };
  });
  liste.sort((a, b) => (b.wert_usd ?? -1) - (a.wert_usd ?? -1));
  return {
    tokens: liste,
    gesamt_usd: liste.reduce((s, t) => s + (t.wert_usd ?? 0), 0),
    stand: stand ?? new Date(jetzt).toISOString(),
    // Wie viele Tokens ohne Preis dabei sind - ehrlicher als sie stumm wegzulassen.
    ohne_preis: liste.filter((t) => t.wert_usd == null).length,
  };
}
