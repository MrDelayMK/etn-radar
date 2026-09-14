// Chain-Reiter: Tageswerte der ganzen Chain, die beobachteten Oekosystem-Tokens
// und frisch verifizierte Contracts. Laeuft im Snapshot-Lauf mit
// (src/ingest.js) und haengt an derselben Explorer-Drossel.
//
// Explorer-Last:
//   - Tageswerte kosten nichts extra. Transaktions-Chart und Adresszahl holt
//     der Snapshot ohnehin, hier werden sie nur abgelegt.
//   - Tokens und Contracts alle sechs Stunden: 5 Tokens x 2 Anfragen plus eine
//     Seite Contracts = 11 Anfragen, rund 44 am Tag.
//
// Der Worker liest nur, was hier abgelegt wird (/api/chain) - null Anfragen
// nach draussen, egal wie viele Leute zuschauen.

import { fetchTokenStand, fetchVerifiedContracts } from "./blockscout.js";
import { CHAIN_TOKENS } from "./chain-tokens.js";

const TOKEN_TAKT_MS = 6 * 3600000;

// Aeltere Contracts braucht die Seite nicht - "New on chain" zeigt eine Woche,
// die Kachel einen Verlauf aus dem, was seit dem Start gesammelt wurde.
const CONTRACTS_MAX_ALTER_MS = 30 * 86400000;

export async function chainSammeln(env, db, { day, stats, txChart, log = () => {} }) {
  const api = env.EXPLORER_API;
  const ergebnis = { tage: 0, tokens: 0, contracts: 0 };

  // --- Tageswerte ---------------------------------------------------------
  const stmts = [];

  // Adressen der Chain vom ERSTEN Snapshot des Tages. Die Differenz zweier
  // Tage sind die neuen Wallets des Vortags.
  if (stats?.total_addresses != null) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO chain_tage (day, total_addresses) VALUES (?,?)" +
            " ON CONFLICT(day) DO UPDATE SET total_addresses = excluded.total_addresses" +
            " WHERE chain_tage.total_addresses IS NULL"
        )
        .bind(day, stats.total_addresses)
    );
  }

  // Transaktionen je Tag, jeder abgeschlossene Tag einmal. Der Explorer
  // rechnet den Chart einmal am Tag fuer den VORTAG: am 14.09. abends endete die
  // Reihe beim 13.09. mit 244.293 - einem Sonntag, so niedrig wie der Sonntag
  // davor. Ein Eintrag mit dem heutigen Datum waere angebrochen und faellt raus.
  const reihe = (txChart ?? [])
    .map((d) => ({ day: String(d.date ?? "").slice(0, 10), tx: Number(d.transaction_count) }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && Number.isFinite(d.tx) && d.day < day)
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  if (reihe.length) {
    const da = new Set(
      (
        await db
          .prepare("SELECT day FROM chain_tage WHERE tx_count IS NOT NULL AND day >= ?")
          .bind(reihe[reihe.length - 1].day)
          .all()
      ).results.map((r) => r.day)
    );
    const ins = db.prepare(
      "INSERT INTO chain_tage (day, tx_count) VALUES (?,?)" +
        " ON CONFLICT(day) DO UPDATE SET tx_count = excluded.tx_count"
    );
    for (const t of reihe) {
      if (da.has(t.day)) continue;
      stmts.push(ins.bind(t.day, t.tx));
      ergebnis.tage++;
    }
  }

  // Die Adress-Zeile laeuft jedes Mal mit, schreibt aber nur beim ersten Lauf
  // des Tages - im Bericht zaehlen nur die neuen Transaktions-Tage.
  if (stmts.length) await db.batch(stmts);

  // --- Tokens und Contracts, alle sechs Stunden -----------------------------
  //
  // Der Takt haengt am letzten VERSUCH, nicht am letzten Erfolg: faellt der
  // Explorer aus, soll nicht jeder 30-Minuten-Lauf dieselben elf Anfragen
  // hinterherschicken.
  const letzter = await db
    .prepare("SELECT last_triggered_at AS t FROM job_control WHERE name = 'chain'")
    .first();
  if (letzter?.t && Date.now() - Date.parse(letzter.t) < TOKEN_TAKT_MS) return ergebnis;
  const jetzt = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO job_control (name, last_triggered_at) VALUES ('chain', ?)" +
        " ON CONFLICT(name) DO UPDATE SET last_triggered_at = excluded.last_triggered_at"
    )
    .bind(jetzt)
    .run();

  const schreiben = [];
  const insToken = db.prepare(
    "INSERT INTO token_tage (day, address, holders, transfers, supply, abgerufen) VALUES (?,?,?,?,?,?)" +
      " ON CONFLICT(day, address) DO UPDATE SET holders = excluded.holders," +
      " transfers = excluded.transfers, supply = excluded.supply, abgerufen = excluded.abgerufen"
  );
  for (const t of CHAIN_TOKENS) {
    try {
      const s = await fetchTokenStand(api, t.address);
      schreiben.push(insToken.bind(day, t.address.toLowerCase(), s.holders, s.transfers, s.supply, jetzt));
      ergebnis.tokens++;
    } catch (e) {
      log("  Token " + t.symbol + " nicht abrufbar: " + e.message);
    }
  }

  try {
    const grenze = Date.now() - CONTRACTS_MAX_ALTER_MS;
    const insContract = db.prepare(
      "INSERT INTO chain_contracts (address, name, impl_name, verified_at, tx_count, abgerufen)" +
        " VALUES (?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET name = excluded.name," +
        " impl_name = excluded.impl_name, tx_count = excluded.tx_count, abgerufen = excluded.abgerufen"
    );
    for (const c of await fetchVerifiedContracts(api)) {
      if (Date.parse(c.verified_at) < grenze) continue;
      schreiben.push(insContract.bind(c.address, c.name, c.impl_name, c.verified_at, c.tx_count, jetzt));
      ergebnis.contracts++;
    }
  } catch (e) {
    log("  Verifizierte Contracts nicht abrufbar: " + e.message);
  }

  if (schreiben.length) await db.batch(schreiben);
  return ergebnis;
}
