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
import { fetchNftCollections } from "./blockscout.js";

const BASIS = "https://electroswap.io/public-api/v1";
const KETTE = 52014; // Electroneum Mainnet, der einzige erlaubte Wert
// Einmal am Tag reicht: die Preise auf der Chain bewegen sich langsam, und
// jeder Abruf kostet Credits (Entscheidung MrDelayMK, 23.09.2026).
export const PREIS_TAKT_MS = 24 * 3600000;
export const BESTAND_TAKT_MS = 24 * 3600000;
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
  // Namen und Dezimalstellen aendern sich fast nie - woechentlich genuegt.
  if (stand?.wert && jetzt - Number(stand.wert) < 7 * 24 * 3600000) return { gefragt: false, grund: "frisch" };
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
    "SELECT address, symbol, name, decimals, total_supply, preis_usd, preis_etn, aktualisiert FROM token_preise"
  ).all().catch(() => ({ results: [] }))).results ?? [];
  return new Map(rows.map((r) => [r.address, {
    symbol: r.symbol, name: r.name, decimals: r.decimals ?? 18, supply: r.total_supply,
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

/*
 * Tageskerzen der verfolgten Tokens - Grundlage der kleinen Kurve auf den
 * Token-Karten und der 24-Stunden-Veraenderung. Einmal am Tag, acht Tage je
 * Token: 100 + 1 je Kerze, also rund 108 Credits pro Token.
 *
 * Die Doku beschreibt die Felder einer Kerze nicht, darum wird nachsichtig
 * gelesen: Zeit aus t/time/timestamp/start, Schlusskurs aus c/close.
 */
const KERZEN_TAGE = 8;

function kerzeLesen(k) {
  if (Array.isArray(k)) return { zeit: k[0], schluss: Number(k[4] ?? k[1]) };
  const zeit = k?.t ?? k?.time ?? k?.timestamp ?? k?.start ?? k?.date ?? k?.bucket;
  const schluss = Number(k?.c ?? k?.close ?? k?.closePrice ?? k?.price);
  return { zeit, schluss };
}
const alsTag = (zeit) => {
  if (zeit == null) return null;
  const zahl = Number(zeit);
  if (Number.isFinite(zahl) && String(zeit).length >= 10) {
    return new Date(zahl < 1e12 ? zahl * 1000 : zahl).toISOString().slice(0, 10);
  }
  const d = Date.parse(zeit);
  return Number.isFinite(d) ? new Date(d).toISOString().slice(0, 10) : null;
};

export async function kerzenAuffrischen(db, env, adressen, jetzt = Date.now()) {
  if (!env.ELECTROSWAP_API_KEY || (await pause(db, jetzt))) return { gefragt: 0 };
  const stand = await db.prepare("SELECT wert FROM electroswap_status WHERE schluessel = 'kerzen'")
    .first().catch(() => null);
  if (stand?.wert && jetzt - Number(stand.wert) < 24 * 3600000) return { gefragt: 0, grund: "frisch" };

  let geholt = 0;
  const zeilen = [];
  for (const adresse of adressen) {
    const r = await holen(
      env,
      "/tokens/" + KETTE + "/" + pruefsummenAdresse(adresse) + "/candles?limit=" + KERZEN_TAGE + "&bucket=1d&currency=USD"
    );
    if (r.fehler === "bremse") {
      await pauseSetzen(db, jetzt + r.warten * 1000);
      break;
    }
    const kerzen = Array.isArray(r.daten) ? r.daten : r.daten?.candles;
    if (!Array.isArray(kerzen)) continue;
    geholt++;
    for (const k of kerzen) {
      const { zeit, schluss } = kerzeLesen(k);
      const tag = alsTag(zeit);
      if (!tag || !(schluss > 0)) continue;
      zeilen.push(
        db.prepare(
          "INSERT INTO token_kerzen (address, tag, schluss) VALUES (?,?,?)" +
            " ON CONFLICT(address, tag) DO UPDATE SET schluss = excluded.schluss"
        ).bind(String(adresse).toLowerCase(), tag, schluss)
      );
    }
  }
  if (geholt) {
    zeilen.push(
      db.prepare("INSERT INTO electroswap_status (schluessel, wert) VALUES ('kerzen', ?)" +
        " ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert").bind(String(jetzt))
    );
    // Aelteres als zwei Wochen brauchen wir nicht.
    zeilen.push(db.prepare("DELETE FROM token_kerzen WHERE tag < ?").bind(new Date(jetzt - 15 * 86400000).toISOString().slice(0, 10)));
    await db.batch(zeilen);
  }
  return { gefragt: geholt, kerzen: zeilen.length };
}

/** Kerzen je Token, aelteste zuerst: Map Adresse -> [{ tag, schluss }]. */
export async function kerzenLesen(db) {
  const rows = (await db.prepare("SELECT address, tag, schluss FROM token_kerzen ORDER BY tag").all()
    .catch(() => ({ results: [] }))).results ?? [];
  const nach = new Map();
  for (const r of rows) {
    if (!nach.has(r.address)) nach.set(r.address, []);
    nach.get(r.address).push({ tag: r.tag, schluss: r.schluss });
  }
  return nach;
}

/*
 * NFTs: welche Sammlungen ein Wallet haelt, kommt vom Explorer (eine Anfrage
 * beim Oeffnen). Der Bodenpreis kommt von ElectroSwap - 500 Credits je
 * Sammlung, hoechstens einmal pro Woche, und nur fuer Sammlungen, die wir
 * wirklich anzeigen.
 */
export const NFT_TAKT_MS = 7 * 24 * 3600000;
// Hoechstens so viele Bodenpreise je Seitenaufruf holen - der Rest folgt beim
// naechsten. So wartet niemand auf zwanzig Abrufe hintereinander.
const NFT_JE_LAUF = 8;

/**
 * Alle gelisteten NFT-Sammlungen samt Bodenpreis, hoechstens einmal pro Woche.
 * Die Liste kostet 300 + 10 je Sammlung, jede Statistik 500. Je Aufruf werden
 * hoechstens NFT_JE_LAUF Statistiken geholt, damit niemand lange wartet - der
 * Rest kommt beim naechsten Seitenaufruf dran.
 */
export async function nftSammlungenAuffrischen(db, env, jetzt = Date.now()) {
  if (!env.ELECTROSWAP_API_KEY || (await pause(db, jetzt))) return { gefragt: 0 };
  const stand = await db.prepare("SELECT wert FROM electroswap_status WHERE schluessel = 'nftliste'")
    .first().catch(() => null);
  if (!stand?.wert || jetzt - Number(stand.wert) >= NFT_TAKT_MS) {
    const r = await holen(env, "/nft/collections/" + KETTE + "?limit=50");
    if (r.fehler === "bremse") {
      await pauseSetzen(db, jetzt + r.warten * 1000);
      return { gefragt: 0, grund: "bremse" };
    }
    if (Array.isArray(r.daten)) {
      const zeilen = r.daten.map((c) =>
        db.prepare(
          "INSERT INTO nft_sammlungen (address, name, symbol, supply) VALUES (?,?,?,?)" +
            " ON CONFLICT(address) DO UPDATE SET name = excluded.name, symbol = excluded.symbol," +
            " supply = excluded.supply"
        ).bind(String(c.address).toLowerCase(), c.name ?? null, c.symbol ?? null, c.totalSupply ?? null)
      );
      zeilen.push(
        db.prepare("INSERT INTO electroswap_status (schluessel, wert) VALUES ('nftliste', ?)" +
          " ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert").bind(String(jetzt))
      );
      await db.batch(zeilen);
    }
  }
  // Sammlungen ohne frischen Bodenpreis, groesste zuerst.
  const offen = ((await db
    .prepare(
      "SELECT address FROM nft_sammlungen WHERE aktualisiert IS NULL OR aktualisiert < ?" +
        " ORDER BY coalesce(supply, 0) DESC LIMIT ?"
    )
    .bind(new Date(jetzt - NFT_TAKT_MS).toISOString(), NFT_JE_LAUF)
    .all().catch(() => ({ results: [] }))).results ?? []).map((r) => r.address);
  if (!offen.length) return { gefragt: 0, grund: "frisch" };
  await bodenpreise(db, env, offen, jetzt);
  return { gefragt: offen.length };
}

async function bodenpreise(db, env, sammlungen, jetzt) {
  if (!env.ELECTROSWAP_API_KEY || !sammlungen.length) return;
  const platz = sammlungen.map(() => "?").join(",");
  const bekannt = (await db
    .prepare("SELECT address, aktualisiert FROM nft_sammlungen WHERE address IN (" + platz + ")")
    .bind(...sammlungen).all().catch(() => ({ results: [] }))).results ?? [];
  const stand = new Map(bekannt.map((r) => [r.address, r.aktualisiert]));
  const zeit = new Date(jetzt).toISOString();
  for (const s of sammlungen) {
    const alt = stand.get(s);
    if (alt && jetzt - Date.parse(alt) < NFT_TAKT_MS) continue;
    if (await pause(db, jetzt)) return;
    const r = await holen(env, "/nft/collections/" + KETTE + "/" + pruefsummenAdresse(s));
    if (r.fehler === "bremse") {
      await pauseSetzen(db, jetzt + r.warten * 1000);
      return;
    }
    // Sammlungen, die ElectroSwap nicht kennt, bekommen trotzdem einen
    // Zeitstempel - sonst fragen wir sie bei jedem Aufruf erneut.
    const d = r.daten ?? {};
    await db
      .prepare(
        "INSERT INTO nft_sammlungen (address, name, symbol, supply, floor_etn, besitzer, angebote, aktualisiert)" +
          " VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET name = excluded.name," +
          " symbol = excluded.symbol, supply = excluded.supply, floor_etn = excluded.floor_etn," +
          " besitzer = excluded.besitzer, angebote = excluded.angebote, aktualisiert = excluded.aktualisiert"
      )
      .bind(s, d.name ?? null, d.symbol ?? null, d.totalSupply ?? null,
        Number(d.stats?.floorPrice) > 0 ? Number(d.stats.floorPrice) : null,
        d.stats?.uniqueOwners ?? null, d.stats?.listingCount ?? null, zeit)
      .run()
      .catch(() => {});
  }
}

/**
 * Antwort fuer /api/wallet-nfts/<adresse>: Sammlungen, Stueckzahl und der
 * Mindestwert zum Bodenpreis. Ausdruecklich KEINE Bewertung - der Bodenpreis
 * ist das billigste Angebot, nicht der Wert eines bestimmten Stuecks.
 */
export async function walletNftWerte(db, env, adresse, etnPreis, jetzt = Date.now()) {
  const adr = String(adresse ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(adr)) return { error: "Keine gueltige Adresse", status: 400 };
  const stand = await db.prepare("SELECT max(gesehen) t FROM wallet_nfts WHERE address = ?").bind(adr)
    .first().catch(() => null);
  if (!stand?.t || jetzt - Date.parse(stand.t) >= BESTAND_TAKT_MS) {
    const zeit = new Date(jetzt).toISOString();
    const gefunden = await fetchNftCollections(env.EXPLORER_API, adr).catch(() => null);
    if (gefunden) {
      const zeilen = [db.prepare("DELETE FROM wallet_nfts WHERE address = ?").bind(adr)];
      for (const s of gefunden) {
        zeilen.push(
          db.prepare("INSERT INTO wallet_nfts (address, sammlung, anzahl, name, symbol, gesehen) VALUES (?,?,?,?,?,?)")
            .bind(adr, s.address, s.anzahl, s.name, s.symbol, zeit)
        );
      }
      zeilen.push(
        db.prepare("INSERT INTO wallet_nfts (address, sammlung, anzahl, gesehen) VALUES (?, '-', 0, ?)" +
          " ON CONFLICT(address, sammlung) DO UPDATE SET gesehen = excluded.gesehen").bind(adr, zeit)
      );
      await db.batch(zeilen).catch(() => {});
    }
  }
  const rows = (await db
    .prepare("SELECT sammlung, anzahl, name, symbol FROM wallet_nfts WHERE address = ? AND sammlung != '-'")
    .bind(adr).all().catch(() => ({ results: [] }))).results ?? [];
  if (!rows.length) return { sammlungen: [], gesamt_usd: 0, stueck: 0, stand: stand?.t ?? new Date(jetzt).toISOString() };

  // Die Bodenpreise liegen bereits in nft_sammlungen (woechentlich fuer alle
  // gelisteten Sammlungen geholt) - hier kostet das keine Anfrage mehr.
  await nftSammlungenAuffrischen(db, env, jetzt).catch(() => {});
  const platz = rows.map(() => "?").join(",");
  const boden = new Map(((await db
    .prepare("SELECT address, name, floor_etn, besitzer, angebote FROM nft_sammlungen WHERE address IN (" + platz + ")")
    .bind(...rows.map((r) => r.sammlung)).all().catch(() => ({ results: [] }))).results ?? [])
    .map((r) => [r.address, r]));

  const liste = rows.map((r) => {
    const b = boden.get(r.sammlung) ?? {};
    const wert = b.floor_etn && etnPreis > 0 ? b.floor_etn * r.anzahl * etnPreis : null;
    return {
      address: r.sammlung,
      name: r.name ?? b.name ?? null,
      symbol: r.symbol ?? null,
      anzahl: r.anzahl,
      floor_etn: b.floor_etn ?? null,
      angebote: b.angebote ?? null,
      wert_usd: wert,
    };
  });
  liste.sort((a, b) => (b.wert_usd ?? -1) - (a.wert_usd ?? -1) || b.anzahl - a.anzahl);
  return {
    sammlungen: liste,
    stueck: liste.reduce((s, x) => s + x.anzahl, 0),
    gesamt_usd: liste.reduce((s, x) => s + (x.wert_usd ?? 0), 0),
    ohne_boden: liste.filter((x) => x.wert_usd == null).length,
    stand: new Date(jetzt).toISOString(),
  };
}
