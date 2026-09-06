// Automatische Boersen-/Dienst-Erkennung.
//
// Beantwortet nur "verhaelt sich das wie eine Boerse", NICHT "welche Boerse
// ist das". Fuer Letzteres gibt es keine automatisierbare Quelle: selbst die
// drei bereits bekannten Boersen (KuCoin, HTX, Biconomy) tragen im Explorer
// keinerlei Namens-Tag (gegengeprueft), und CoinMarketCap listet nur, WO ETN
// gehandelt wird - nicht die Wallet-Adressen dahinter. Der echte Name bleibt
// darum immer Handarbeit ueber labels.json.
//
// Vier Signale, alle aus dem Verhalten der Adresse, nicht aus ihrem Namen:
//
//   1. Gegenpartei-Vielfalt   Eine Person hat wenige, eine Boerse Tausende
//                             verschiedene Gegenparteien.
//   2. Transaktionszahl       current_balances.tx_count relativ zu einer
//                             Schwelle (aus dem Snapshot, kostet nichts extra).
//   3. Beidseitiger Fluss     Boersen empfangen UND zahlen staendig aus;
//                             ein Whale meist nur das eine oder das andere.
//   4. Zeitliche Streuung     Boersen sind 24/7 aktiv, Menschen eher gebuendelt.
//
// Ergebnis ist ein Score 0..1, keine Ja/Nein-Entscheidung. Ab einer Schwelle
// wird automatisch label_type='service', label_source='auto' gesetzt - aber
// NIE eine bereits vorhandene (insbesondere manuelle) Kennzeichnung
// ueberschrieben.

import { fetchInboundTransactions, fetchOutboundTransactions } from "./blockscout.js";

const MAX_PAGES = 3; // 3 * 50 = 150 Transaktionen je Richtung - ein Verhaltensmuster
                      // braucht keine vollstaendige Historie wie die Cluster-Analyse.
const AUTO_SCHWELLE = 0.7;
const TOP_N_STANDARD = 500; // Boersen sind immer unter den groessten Wallets

/** Streuung der Aktivitaet ueber den Tag: 0 = alles zur selben Stunde, 1 = gleichmaessig ueber 24h. */
function zeitStreuung(transfers) {
  if (transfers.length < 8) return 0; // zu wenig fuer eine verlaessliche Aussage
  const stunden = new Array(24).fill(0);
  for (const t of transfers) {
    const h = new Date(t.timestamp).getUTCHours();
    if (!Number.isNaN(h)) stunden[h]++;
  }
  const belegteStunden = stunden.filter((n) => n > 0).length;
  return belegteStunden / 24;
}

function berechneScore({ txCount, inbound, outbound }) {
  const gegenparteien = new Set([
    ...inbound.transfers.map((t) => t.from),
    ...outbound.transfers.map((t) => t.to),
  ]);
  // Ab 60 verschiedenen Gegenparteien in nur 300 Transaktionen ist das Vollausschlag -
  // ein normaler Mensch wiederholt sich staerker (Boerse, Freunde, eigene Wallets).
  const gegenparteiScore = Math.min(1, gegenparteien.size / 60);

  const txScore = Math.min(1, (txCount ?? 0) / 2000);

  // Nicht nur ZAEHLEN, ob beide Richtungen vorkommen, sondern ob sich auch der
  // WERT die Waage haelt. Eine Boerse hat staendig etwa gleich viel Zu- und
  // Abfluss (Durchlaufbetrieb). Eine Team-/Treasury-Wallet dagegen sieht oft
  // aehnlich aus (viele Empfaenger, hohe Gegenpartei-Zahl) - bewegt aber in
  // eine Richtung viel mehr Wert als in die andere (einmal grosse Zuteilung,
  // danach viele kleine Auszahlungen, oder umgekehrt). Ohne diese Gewichtung
  // waere eine Team-Wallet nicht von einer Boerse zu unterscheiden.
  const weiSum = (transfers) => transfers.reduce((s, t) => s + BigInt(t.value_wei), 0n);
  const einWei = weiSum(inbound.transfers);
  const ausWei = weiSum(outbound.transfers);
  const hatBeide = inbound.transfers.length >= 5 && outbound.transfers.length >= 5;
  const wertBalance =
    einWei > 0n && ausWei > 0n
      ? Number(einWei < ausWei ? einWei : ausWei) / Number(einWei > ausWei ? einWei : ausWei)
      : 0;
  const richtungScore = hatBeide ? wertBalance : 0;

  const alle = [...inbound.transfers, ...outbound.transfers];
  const zeitScore = zeitStreuung(alle);

  const score =
    0.4 * gegenparteiScore + 0.25 * txScore + 0.2 * richtungScore + 0.15 * zeitScore;

  return {
    score: Math.round(score * 1000) / 1000,
    signale: {
      gegenparteien: gegenparteien.size,
      gegenpartei_score: Math.round(gegenparteiScore * 100) / 100,
      tx_count: txCount ?? null,
      tx_score: Math.round(txScore * 100) / 100,
      beidseitig: hatBeide,
      wert_balance: Math.round(wertBalance * 100) / 100, // 1.0 = perfekt ausgeglichen, 0 = Einbahnstrasse
      zeit_streuung: Math.round(zeitScore * 100) / 100,
    },
  };
}

/**
 * @param {object} env  { EXPLORER_API, BRIDGE_ADDRESS }
 * @param {object} db   D1-kompatible Datenbank
 * @param {object} opts { parallel, limit, log, onProgress }
 */
export async function runExchangeDetection(env, db, opts = {}) {
  const log = opts.log ?? (() => {});
  const parallel = opts.parallel ?? 3;
  const api = env.EXPLORER_API;
  const bridge = String(env.BRIDGE_ADDRESS ?? "").toLowerCase();

  // Bereits manuell oder automatisch gelabelte Adressen ueberspringen - kein
  // Grund, eine bestaetigte Zuordnung erneut abzufragen und den Explorer
  // unnoetig zu belasten.
  const todo = (
    await db
      .prepare(
        "SELECT c.address, c.tx_count FROM current_balances c" +
          " LEFT JOIN addresses a ON a.hash = c.address" +
          " WHERE c.in_top_n = 1 AND c.address != ? AND a.label_type IS NULL" +
          // Contracts nie automatisch als Boerse labeln: ein Staking-/Vesting-
          // /Rewards-Contract kann genau dasselbe Fan-out-Muster zeigen wie eine
          // Boerse, ist aber eindeutig keine - dafuer gibt es schon das eigene
          // "Contract"-Tag (is_contract), das nicht mit einer Vermutung
          // ueberschrieben werden soll.
          " AND COALESCE(a.is_contract, 0) = 0" +
          " ORDER BY c.etn DESC LIMIT ?"
      )
      .bind(bridge, opts.limit ?? TOP_N_STANDARD)
      .all()
  ).results;

  log(todo.length + " Wallets zu pruefen (parallel: " + parallel + ")");
  if (todo.length === 0) return { done: 0, erkannt: 0, failed: 0 };

  const upsert = db.prepare(
    "INSERT INTO addresses (hash, checksum_hash, first_seen, last_seen, exchange_score, exchange_signale)" +
      " VALUES (?,?,?,?,?,?)" +
      " ON CONFLICT(hash) DO UPDATE SET exchange_score = excluded.exchange_score," +
      "   exchange_signale = excluded.exchange_signale"
  );
  // Nur setzen, wenn noch KEIN Label existiert - siehe Kopfkommentar. Ein
  // spaeterer manueller Eintrag in labels.json ueberschreibt das jederzeit.
  const setAutoLabel = db.prepare(
    "UPDATE addresses SET label_type='service', label_source='auto'," +
      " notes = COALESCE(notes, ?) WHERE hash = ? AND label_type IS NULL"
  );

  const state = { done: 0, erkannt: 0, failed: 0 };
  const t0 = Date.now();
  const queue = [...todo];
  const jetzt = new Date().toISOString();

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;
      try {
        const [inbound, outbound] = await Promise.all([
          fetchInboundTransactions(api, row.address, { maxPages: MAX_PAGES }),
          fetchOutboundTransactions(api, row.address, { maxPages: MAX_PAGES }),
        ]);
        const { score, signale } = berechneScore({
          txCount: row.tx_count,
          inbound,
          outbound,
        });

        await upsert
          .bind(row.address, row.address, jetzt, jetzt, score, JSON.stringify(signale))
          .run();

        if (score >= AUTO_SCHWELLE) {
          state.erkannt++;
          await setAutoLabel
            .bind(
              "Automatisch erkannt (Score " + score.toFixed(2) + ") anhand des Verhaltens " +
                "(Gegenpartei-Vielfalt, Durchlauf-Betrieb, 24/7-Aktivitaet). Echter Name " +
                "unbekannt - koennte auch eine Team-/Treasury-/Ausschuettungs-Wallet sein, " +
                "die aehnlich viele Empfaenger hat. Von Hand pruefen, bevor der Name feststeht.",
              row.address
            )
            .run();
        }
      } catch (e) {
        state.failed++;
        if (state.failed <= 5) log("  Fehler bei " + row.address + ": " + e.message);
      }
      state.done++;
      if (opts.onProgress && (state.done % 25 === 0 || state.done === todo.length)) {
        const rate = state.done / ((Date.now() - t0) / 1000);
        opts.onProgress(state.done, todo.length, Math.round((todo.length - state.done) / rate));
      }
    }
  }

  await Promise.all(Array.from({ length: parallel }, worker));
  const ms = Date.now() - t0;
  log(
    "Fertig in " + (ms / 60000).toFixed(1) + " Minuten: " + state.done +
      " geprueft, " + state.erkannt + " als moegliche Boerse/Dienst markiert (Score >= " +
      AUTO_SCHWELLE + "), " + state.failed + " Fehler"
  );

  await db
    .prepare(
      "INSERT INTO exchange_detect_runs (taken_at, day, wallets_geprueft, erkannt, duration_ms, status)" +
        " VALUES (?,?,?,?,?,?)"
    )
    .bind(jetzt, jetzt.slice(0, 10), state.done, state.erkannt, ms, "ok")
    .run();

  return state;
}
