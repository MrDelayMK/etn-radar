// Chain-Reiter: liest, was der Snapshot-Lauf in src/chain.js abgelegt hat.

import { CHAIN_TOKENS, tradeLink } from "../chain-tokens.js";
import { tagVor } from "./grundlagen.js";
import { exchange_flow } from "./wallets.js";

/* ---------- Chain-Reiter ---------------------------------------------------
 *
 * Liest nur, was der Snapshot-Lauf abgelegt hat (src/chain.js) - null
 * Anfragen an den Explorer, egal wie viele zuschauen.
 *
 * "Diese Woche" sind die letzten sieben ABGESCHLOSSENEN Tage. Der laufende Tag
 * waere ein halber und zoege jeden Vergleich nach unten.
 */
export async function chain(db, env) {
  const alle = (sql, ...werte) =>
    db.prepare(sql).bind(...werte).all().then((r) => r.results ?? []).catch(() => []);
  const bridge = String(env.BRIDGE_ADDRESS ?? "").toLowerCase();
  const heute = tagVor(0);
  const woche = { von: tagVor(7), bis: tagVor(1) };
  const vorwoche = { von: tagVor(14), bis: tagVor(8) };

  const vor7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const [tage, tokenZeilen, contracts, bridgeTage, bewegung, kurse, kursJetzt, kursVor7, boersen] = await Promise.all([
    alle("SELECT day, tx_count FROM chain_tage WHERE day >= ? ORDER BY day", tagVor(92)),
    alle(
      "SELECT day, address, holders, transfers, supply FROM token_tage WHERE day >= ? ORDER BY day",
      tagVor(15)
    ),
    alle(
      "SELECT address, name, impl_name, verified_at, tx_count FROM chain_contracts" +
        " WHERE verified_at >= ? ORDER BY verified_at",
      tagVor(92)
    ),
    alle("SELECT day, abfluss_wei FROM bridge_tage WHERE day >= ?", vorwoche.von),
    // Die groesste einzelne Bewegung der Woche, ohne die Bridge selbst.
    alle(
      "SELECT e.address, e.delta_etn, a.label, a.checksum_hash FROM events e" +
        " LEFT JOIN addresses a ON a.hash = e.address" +
        " WHERE e.detected_at >= ? AND e.detected_at < ? AND e.type IN ('gain','loss')" +
        " AND e.address != ? ORDER BY abs(e.delta_etn) DESC LIMIT 1",
      woche.von + "T00:00:00Z",
      heute + "T00:00:00Z",
      bridge
    ),
    // Der Kurs ist anders als der Rest nicht die abgeschlossene Woche, sondern
    // live: letzter Snapshot gegen den von vor genau sieben Tagen. Tief und
    // Hoch aus den Tageskursen dazwischen (heute = letzter Snapshot).
    alle(
      "SELECT day, etn_price FROM network_daily WHERE day >= ? AND etn_price > 0 ORDER BY day",
      woche.von
    ),
    alle("SELECT etn_price FROM snapshots WHERE status='ok' AND etn_price > 0 ORDER BY id DESC LIMIT 1"),
    // Ueber den Tages-Index: liest nur die rund 48 Snapshots jenes Tages.
    alle(
      "SELECT etn_price FROM snapshots WHERE day = ? AND taken_at <= ? AND status='ok' AND etn_price > 0" +
        " ORDER BY taken_at DESC LIMIT 1",
      woche.von,
      vor7
    ),
    // Netto auf bzw. von den gelabelten Boersen, gleiche Rechnung wie in Activity.
    exchange_flow(db, new URL("https://x/?from=" + woche.von + "&to=" + woche.bis)).catch(() => null),
  ]);

  // Summe einer Tagesreihe ueber einen Zeitraum samt Zahl der Tage mit Wert:
  // zwei Wochen zu vergleichen ist nur mit je sieben Tagen ehrlich.
  const summe = (reihe, z) => {
    const drin = reihe.filter((p) => p.day >= z.von && p.day <= z.bis);
    return drin.length ? { summe: drin.reduce((a, p) => a + p.n, 0), tage: drin.length } : null;
  };
  const kachel = (reihe) => ({
    reihe: reihe.slice(-90),
    woche: summe(reihe, woche),
    vorwoche: summe(reihe, vorwoche),
  });

  const tx = tage
    .filter((t) => t.tx_count != null && t.day < heute)
    .map((t) => ({ day: t.day, n: t.tx_count }));

  // Verifizierte Contracts je Tag. Der aelteste gesammelte Tag ist nur
  // angebrochen - die erste abgerufene Seite endete mittendrin - und faellt
  // raus. Tage ohne Verifizierung zaehlen als 0.
  const proTag = {};
  for (const c of contracts) {
    const d = c.verified_at.slice(0, 10);
    proTag[d] = (proTag[d] ?? 0) + 1;
  }
  const contractReihe = [];
  if (contracts.length) {
    const ab = Date.parse(contracts[0].verified_at.slice(0, 10)) + 86400000;
    for (let t = ab; t < Date.parse(heute); t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      contractReihe.push({ day: d, n: proTag[d] ?? 0 });
    }
  }

  // "New on chain": gleiche Vorlagen zusammengefasst. Am 14.09. kamen zehn
  // GnosisSafe- und GamePool-Kopien in derselben Sekunde - als Einzelzeilen
  // waere die Liste nur Rauschen. Bei Proxys zaehlt die Implementierung.
  const gruppen = new Map();
  for (const c of contracts) {
    if (c.verified_at < woche.von) continue;
    const name = c.impl_name || c.name || "Unnamed contract";
    const g = gruppen.get(name) ?? { name, anzahl: 0, tx: 0, neuste: c.verified_at, address: c.address, _top: -1 };
    g.anzahl++;
    g.tx += c.tx_count ?? 0;
    if (c.verified_at > g.neuste) g.neuste = c.verified_at;
    if ((c.tx_count ?? 0) > g._top) {
      g._top = c.tx_count ?? 0;
      g.address = c.address;
    }
    gruppen.set(name, g);
  }
  const neu = [...gruppen.values()]
    .sort((a, b) => b.tx - a.tx || b.anzahl - a.anzahl || (a.neuste < b.neuste ? 1 : -1))
    .map(({ _top, ...g }) => g);

  const inEtn = (wei) => Number(BigInt(wei) / 10n ** 12n) / 1e6;
  const migriert = (z) =>
    bridgeTage.filter((t) => t.day >= z.von && t.day <= z.bis).reduce((a, t) => a + inEtn(t.abfluss_wei), 0);

  const tokens = CHAIN_TOKENS.map((t) => {
    const adresse = t.address.toLowerCase();
    const zeilen = tokenZeilen.filter((z) => z.address === adresse);
    const jetzt = zeilen[zeilen.length - 1];
    // Vergleichsstand vor sieben Tagen - aber nicht aelter als neun, sonst
    // hiesse "this week" in Wahrheit zwei.
    const vorher = [...zeilen].reverse().find((z) => z.day <= tagVor(7) && z.day >= tagVor(9));
    const diff = (feld) => (jetzt?.[feld] != null && vorher?.[feld] != null ? jetzt[feld] - vorher[feld] : null);
    return {
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      logo: t.logo,
      trade: tradeLink(t.address),
      holders: jetzt?.holders ?? null,
      holders_7d: diff("holders"),
      transfers: jetzt?.transfers ?? null,
      transfers_7d: diff("transfers"),
      supply: jetzt?.supply ?? null,
    };
  }).sort((a, b) => (b.holders ?? -1) - (a.holders ?? -1));

  const jetzt = kursJetzt[0]?.etn_price;
  const vorher = kursVor7[0]?.etn_price;
  const alleKurse = [...kurse.map((k) => k.etn_price), jetzt, vorher].filter((p) => p > 0);
  const preis = jetzt && vorher
    ? { start: vorher, ende: jetzt, hoch: Math.max(...alleKurse), tief: Math.min(...alleKurse) }
    : null;

  const b = bewegung[0];
  return {
    woche,
    preis,
    // Groesster Einzelposten dazu: am 18.09. stammten 427 Mio. von 479 Mio. aus
    // einem einzigen KuCoin-Abfluss an drei unbekannte Wallets - ohne den
    // Hinweis laese sich das wie ein Ansturm vieler Anleger.
    boersen: boersen?.boersen_gezaehlt
      ? {
          netto: boersen.netto_etn,
          groesste: boersen.pro_boerse[0]
            ? { label: boersen.pro_boerse[0].label, netto: boersen.pro_boerse[0].netto_etn }
            : null,
        }
      : null,
    tx: kachel(tx),
    contracts: { ...kachel(contractReihe), gruppen: neu.slice(0, 6), weitere: Math.max(0, neu.length - 6) },
    migration: bridgeTage.length ? { woche: migriert(woche), vorwoche: migriert(vorwoche) } : null,
    bewegung: b ? { address: b.address, checksum_hash: b.checksum_hash, label: b.label, etn: b.delta_etn } : null,
    tokens,
  };
}
