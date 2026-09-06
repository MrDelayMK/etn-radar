// Kern des Trackers: einen Snapshot ziehen, mit dem letzten Stand vergleichen,
// Aenderungen und Ereignisse ableiten, alles in D1 schreiben.
//
// Bewusst umgebungsneutral: bekommt ein `db` mit D1-Interface
// (prepare/bind/all/run/batch). Laeuft dadurch identisch im Worker (native D1)
// und in Node (HTTP-Adapter, siehe src/db-http.js).

import { fetchTopAddresses, fetchStats } from "./blockscout.js";
import { tierFor } from "./tiers.js";
import { benachrichtigeSleeperWakes } from "./telegram.js";

const CHUNK = 100; // Statements pro D1-Batch

// Ab wie vielen Tagen ohne Bewegung gilt ein Wallet als "Schlaefer".
const SLEEPER_DAYS = 30;

// Ab welcher bewegten Menge ein Ereignis ueberhaupt eines ist.
//
// Vorher hing an gain/loss nur eine Untergrenze von 1.000 ETN (ueber
// severity()), und sleeper_wake, tier_up und tier_down hatten gar keine. Ein
// Wallet mit 40 Millionen ETN, das nach Monaten Stille 84 ETN bewegt, stand
// dadurch als "Sleeper woke up" in der Liste - gemessen an der Fragestellung
// des Dashboards ist das nichts, sondern Gebuehren oder Staub.
//
// 100.000 ETN als Grenze: das ist ein Fuenftel der kleinsten hier gefuehrten
// Stufe (Octopus ab 500.000) und damit auch fuer das kleinste beobachtete
// Wallet noch eine erkennbare Bewegung. Gemessen an den bisher gesammelten
// Ereignissen faellt damit rund die Haelfte weg - fast ausschliesslich
// Betraege unter 10.000 ETN.
const MIN_EREIGNIS_ETN = 100000;

async function batched(db, statements) {
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK));
  }
  return statements.length;
}

/** Wie bedeutsam ist eine Bewegung? 0..100, logarithmisch nach ETN-Betrag. */
function severity(deltaEtn, pct) {
  const abs = Math.abs(deltaEtn);
  if (abs < 1000) return 0;
  // 1k ETN -> ~0, 1M -> ~75, 100M -> ~125 (gedeckelt), plus Zuschlag fuer Prozent
  const bySize = Math.min(100, Math.log10(abs / 1000) * 25);
  const byPct = Math.min(30, Math.abs(pct || 0) / 3);
  return Math.round(Math.min(100, bySize + byPct));
}

/**
 * Fuehrt einen kompletten Snapshot-Lauf aus.
 * @param {object} env  Konfiguration (EXPLORER_API, TRACK_TOP_N, BRIDGE_ADDRESS)
 * @param {object} db   D1-kompatible Datenbank
 * @param {object} opts { onProgress, log }
 */
export async function runIngest(env, db, opts = {}) {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const takenAt = new Date().toISOString();
  const day = takenAt.slice(0, 10);
  const topN = Number.parseInt(env.TRACK_TOP_N ?? "3000", 10);
  const bridge = String(env.BRIDGE_ADDRESS ?? "").toLowerCase();

  // --- 1. Daten holen ---------------------------------------------------
  log("Snapshot " + takenAt + ": lade Top " + topN + " ...");
  const [top, stats] = await Promise.all([
    fetchTopAddresses(env.EXPLORER_API, topN, opts.onProgress),
    fetchStats(env.EXPLORER_API).catch(() => ({})),
  ]);
  const rows = top.rows;
  if (rows.length === 0) throw new Error("Explorer lieferte keine Adressen - Abbruch");
  log("  " + rows.length + " Adressen in " + top.pages + " Seiten geladen");

  const price = top.exchange_rate ?? stats.coin_price ?? null;
  const bridgeRow = rows.find((r) => r.hash === bridge);

  // --- 2. Bisherigen Stand laden ---------------------------------------
  //
  // Auch die Stammdaten aus `addresses` mitladen. Sie werden hier nicht
  // gebraucht, um sie anzuzeigen, sondern um VERGLEICHEN zu koennen: nur was
  // sich wirklich geaendert hat, wird spaeter geschrieben. Siehe die
  // Schreibbudget-Begruendung weiter unten.
  const prevRes = await db
    .prepare(
      "SELECT c.address, c.balance_wei, c.etn, c.rank_pos, c.tier, c.tx_count, c.updated_at," +
        " c.in_top_n, a.checksum_hash, a.is_contract, a.contract_name, a.impl_name, a.ens_name" +
        " FROM current_balances c LEFT JOIN addresses a ON a.hash = c.address"
    )
    .all();
  const prev = new Map((prevRes.results ?? []).map((r) => [r.address, r]));
  const bootstrap = prev.size === 0;
  log("  Vorheriger Stand: " + prev.size + " Adressen" + (bootstrap ? " (Erstlauf)" : ""));

  // --- 3. Snapshot-Kopfzeile -------------------------------------------
  await db
    .prepare(
      "INSERT INTO snapshots (taken_at, day, total_supply, bridge_wei, etn_price," +
        " addr_count, total_addresses, status) VALUES (?,?,?,?,?,?,?,'running')"
    )
    .bind(
      takenAt, day, top.total_supply, bridgeRow?.balance_wei ?? null, price,
      rows.length, stats.total_addresses ?? null
    )
    .run();
  const snapId = (
    await db.prepare("SELECT id FROM snapshots WHERE taken_at = ?").bind(takenAt).first()
  ).id;

  // --- 4. Vergleichen ---------------------------------------------------
  const stmts = [];
  const events = [];
  let changed = 0;

  const upsertAddr = db.prepare(
    "INSERT INTO addresses (hash, checksum_hash, first_seen, last_seen, is_contract, contract_name, impl_name, ens_name)" +
      " VALUES (?,?,?,?,?,?,?,?)" +
      " ON CONFLICT(hash) DO UPDATE SET" +
      "   last_seen     = excluded.last_seen," +
      "   checksum_hash = excluded.checksum_hash," +
      "   is_contract   = excluded.is_contract," +
      "   contract_name = COALESCE(excluded.contract_name, addresses.contract_name)," +
      "   impl_name     = COALESCE(excluded.impl_name, addresses.impl_name)," +
      "   ens_name      = COALESCE(excluded.ens_name, addresses.ens_name)"
  );
  const insBalance = db.prepare(
    "INSERT OR REPLACE INTO balances (snapshot_id, address, rank_pos, balance_wei, etn, tx_count, delta_wei)" +
      " VALUES (?,?,?,?,?,?,?)"
  );
  const upsertCurrent = db.prepare(
    "INSERT INTO current_balances (address, rank_pos, balance_wei, etn, tx_count, tier, updated_at, last_snapshot, in_top_n)" +
      " VALUES (?,?,?,?,?,?,?,?,1)" +
      " ON CONFLICT(address) DO UPDATE SET" +
      "   rank_pos      = excluded.rank_pos," +
      "   balance_wei   = excluded.balance_wei," +
      "   etn           = excluded.etn," +
      // COALESCE, weil der Explorer transaction_count gelegentlich als "" bzw.
      // null liefert. Ohne das wuerde ein bereits bekannter Wert geloescht.
      "   tx_count      = COALESCE(excluded.tx_count, current_balances.tx_count)," +
      "   tier          = excluded.tier," +
      "   updated_at    = excluded.updated_at," +
      "   last_snapshot = excluded.last_snapshot," +
      "   in_top_n      = 1"
  );
  const upsertDaily = db.prepare(
    "INSERT INTO daily_balances (address, day, balance_wei, etn, source)" +
      " VALUES (?,?,?,?,'snapshot')" +
      " ON CONFLICT(address, day) DO UPDATE SET" +
      "   balance_wei = excluded.balance_wei, etn = excluded.etn, source = 'snapshot'"
  );
  // Nur die Rangposition auffrischen, wenn sich die Balance NICHT geaendert hat.
  // updated_at bleibt dabei bewusst stehen - es markiert die letzte echte Bewegung.
  const touchCurrent = db.prepare(
    "UPDATE current_balances SET rank_pos = ?, last_snapshot = ?, in_top_n = 1 WHERE address = ?"
  );
  const markDropped = db.prepare("UPDATE current_balances SET in_top_n = 0 WHERE address = ?");

  for (const r of rows) {
    const p = prev.get(r.hash);
    const tier = tierFor(r.etn).key;

    // SCHREIBBUDGET: D1 erlaubt im Gratis-Tarif 100.000 geschriebene Zeilen
    // pro Tag. Vorher lief hier ein Upsert fuer JEDE Adresse bei JEDEM
    // Snapshot - 3.000 Zeilen alle 30 Minuten, also 144.000 taeglich, nur um
    // last_seen fortzuschreiben. Zusammen mit dem touchCurrent weiter unten
    // waren es rund 289.000 Zeilen taeglich; das Limit wurde entsprechend
    // jeden Tag gerissen und die Jobs brachen ab.
    //
    // Tatsaechlich aendern sich pro Snapshot etwa NEUN von 3.000 Adressen.
    // Darum wird hier nur noch geschrieben, was sich wirklich unterscheidet.
    const stammdatenNeu =
      !p ||
      p.checksum_hash !== r.checksum ||
      (p.is_contract ?? 0) !== (r.is_contract ?? 0) ||
      (r.contract_name && p.contract_name !== r.contract_name) ||
      (r.impl_name && p.impl_name !== r.impl_name) ||
      (r.ens_name && p.ens_name !== r.ens_name);

    if (stammdatenNeu) {
      stmts.push(
        upsertAddr.bind(
          r.hash,
          r.checksum,
          takenAt,
          takenAt,
          r.is_contract,
          r.contract_name,
          r.impl_name,
          r.ens_name
        )
      );
    }

    const balanceChanged = !p || p.balance_wei !== r.balance_wei;

    if (balanceChanged) {
      changed++;
      const deltaWei = p ? (BigInt(r.balance_wei) - BigInt(p.balance_wei)).toString() : null;
      stmts.push(
        insBalance.bind(snapId, r.hash, r.rank_pos, r.balance_wei, r.etn, r.tx_count, deltaWei)
      );
      stmts.push(
        upsertCurrent.bind(
          r.hash, r.rank_pos, r.balance_wei, r.etn, r.tx_count, tier, takenAt, snapId
        )
      );
      stmts.push(upsertDaily.bind(r.hash, day, r.balance_wei, r.etn));

      // --- Ereignisse ableiten (beim Erstlauf ueberspringen) ---
      if (!bootstrap && p) {
        const deltaEtn = r.etn - p.etn;
        const pct = p.etn > 0 ? (deltaEtn / p.etn) * 100 : 0;
        const sev = severity(deltaEtn, pct);

        if (sev > 0 && Math.abs(deltaEtn) >= MIN_EREIGNIS_ETN) {
          events.push({
            type: deltaEtn > 0 ? "gain" : "loss",
            address: r.hash, delta_wei: deltaWei, delta_etn: deltaEtn, delta_pct: pct,
            rank_from: p.rank_pos, rank_to: r.rank_pos, severity: sev,
          });
        }
        // Schlaefer erwacht.
        //
        // Definition ueber die RUHEDAUER, nicht ueber transaction_count: der
        // Explorer liefert tx_count unzuverlaessig (leerer String, und im
        // Einzeladress-Endpoint fehlt das Feld ganz). current_balances.updated_at
        // markiert dagegen exakt die letzte echte Balance-Bewegung und wird beim
        // Backfill aus der 90-Tage-Historie vorbelegt.
        //
        // Das ist die Kernfrage des Trackers: welche lange stillen Wallets
        // wachen auf, je naeher die Migrations-Deadline rueckt.
        const idleDays = p.updated_at
          ? (Date.parse(takenAt) - Date.parse(p.updated_at)) / 86400000
          : 0;
        const neverMoved = (p.tx_count ?? -1) === 0; // zusaetzliches, staerkeres Signal
        if (
          p.etn >= 1000000 &&
          Math.abs(deltaEtn) >= MIN_EREIGNIS_ETN &&
          (idleDays >= SLEEPER_DAYS || neverMoved)
        ) {
          events.push({
            type: "sleeper_wake", address: r.hash, delta_wei: deltaWei,
            delta_etn: deltaEtn, delta_pct: pct,
            rank_from: p.rank_pos, rank_to: r.rank_pos,
            severity: Math.min(100, Math.max(80, sev) + (neverMoved ? 10 : 0)),
            meta: JSON.stringify({
              ruhend_mit_etn: p.etn,
              ruhetage: Math.round(idleDays),
              nie_bewegt: neverMoved,
            }),
          });
        }
        // Wallet praktisch leergeraeumt. Einziger Fall ohne die
        // MIN_EREIGNIS_ETN-Grenze: 95 Prozent eines Wallets sind auch dann
        // bemerkenswert, wenn der absolute Betrag knapp darunter liegt.
        if (p.etn >= 100000 && r.etn < p.etn * 0.05) {
          events.push({
            type: "drained", address: r.hash, delta_wei: deltaWei,
            delta_etn: deltaEtn, delta_pct: pct,
            rank_from: p.rank_pos, rank_to: r.rank_pos, severity: Math.max(75, sev),
          });
        }
        // Tier-Wechsel
        if (p.tier && p.tier !== tier && Math.abs(deltaEtn) >= MIN_EREIGNIS_ETN) {
          events.push({
            type: deltaEtn > 0 ? "tier_up" : "tier_down", address: r.hash,
            delta_wei: deltaWei, delta_etn: deltaEtn, delta_pct: pct,
            rank_from: p.rank_pos, rank_to: r.rank_pos,
            tier_from: p.tier, tier_to: tier, severity: Math.max(60, sev),
          });
        }
      }
    } else if (p.rank_pos !== r.rank_pos || p.in_top_n === 0) {
      // Balance unveraendert: nur anfassen, wenn sich der RANG verschoben hat
      // (jemand anderes hat sich bewegt) oder das Wallet aus den Top N
      // zurueckgekehrt ist. Sonst waeren das ~2.990 ueberfluessige Zeilen pro
      // Lauf. last_snapshot wird dabei bewusst nicht mehr fortgeschrieben -
      // die Spalte wird nirgends gelesen.
      stmts.push(touchCurrent.bind(r.rank_pos, snapId, r.hash));
    }

    // Neu in den Top N
    if (!bootstrap && !p) {
      events.push({
        type: "rank_enter", address: r.hash, delta_etn: r.etn,
        rank_to: r.rank_pos, tier_to: tier,
        severity: r.etn >= 10000000 ? 70 : 40,
      });
    }
  }

  // --- 5. Aus den Top N gefallen ---------------------------------------
  //
  // Nur die, die BISHER drin waren (in_top_n = 1). Ohne diese Bedingung wird
  // jede einmal herausgefallene Adresse bei JEDEM weiteren Lauf erneut als
  // gefallen markiert und loest erneut ein rank_exit-Ereignis aus - dauerhaft,
  // fuer immer. Bei 7.000 alten Adressen waren das 14.000 ueberfluessige
  // Schreibvorgaenge pro Lauf und eine Ereignisliste voller Wiederholungen.
  const seen = new Set(rows.map((r) => r.hash));
  const dropped = [...prev.entries()]
    .filter(([a, p]) => !seen.has(a) && p.in_top_n !== 0)
    .map(([a]) => a);
  for (const a of dropped) {
    stmts.push(markDropped.bind(a));
    if (!bootstrap) {
      events.push({
        type: "rank_exit", address: a,
        rank_from: prev.get(a).rank_pos, severity: 35,
      });
    }
  }
  log(
    "  " + changed + " Balancen geaendert, " + dropped.length + " aus Top " + topN +
      " gefallen, " + events.length + " Ereignisse"
  );

  // --- 6. Ereignisse schreiben -----------------------------------------
  const insEvent = db.prepare(
    "INSERT INTO events (detected_at, snapshot_id, type, address, delta_wei, delta_etn, delta_pct," +
      " rank_from, rank_to, tier_from, tier_to, severity, meta)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (const e of events) {
    stmts.push(
      insEvent.bind(
        takenAt, snapId, e.type, e.address,
        e.delta_wei ?? null, e.delta_etn ?? null, e.delta_pct ?? null,
        e.rank_from ?? null, e.rank_to ?? null,
        e.tier_from ?? null, e.tier_to ?? null,
        e.severity ?? 0, e.meta ?? null
      )
    );
  }

  // --- 7. Netzwerk-Kennzahlen des Tages --------------------------------
  const totalSupplyEtn = Number(top.total_supply ?? 0);
  const bridgeEtn = bridgeRow?.etn ?? 0;
  const circulating = totalSupplyEtn - bridgeEtn;
  const real = rows.filter((r) => r.hash !== bridge); // Bridge zaehlt nicht als Holder
  const sumTop = (n) => real.slice(0, n).reduce((s, r) => s + r.etn, 0);

  stmts.push(
    db
      .prepare(
        "INSERT INTO network_daily (day, total_supply, bridge_wei, circulating_wei, etn_price," +
          " holders_1m, holders_5m, holders_10m, top10_share, top100_share, top1000_share)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,?)" +
          " ON CONFLICT(day) DO UPDATE SET" +
          "   total_supply=excluded.total_supply, bridge_wei=excluded.bridge_wei," +
          "   circulating_wei=excluded.circulating_wei, etn_price=excluded.etn_price," +
          "   holders_1m=excluded.holders_1m, holders_5m=excluded.holders_5m," +
          "   holders_10m=excluded.holders_10m, top10_share=excluded.top10_share," +
          "   top100_share=excluded.top100_share, top1000_share=excluded.top1000_share"
      )
      .bind(
        day,
        top.total_supply,
        bridgeRow?.balance_wei ?? null,
        String(circulating),
        price,
        real.filter((r) => r.etn >= 1000000).length,
        real.filter((r) => r.etn >= 5000000).length,
        real.filter((r) => r.etn >= 10000000).length,
        circulating > 0 ? sumTop(10) / circulating : null,
        circulating > 0 ? sumTop(100) / circulating : null,
        // Nur belastbar, wenn tatsaechlich >= 1000 Wallets erfasst sind - sonst
        // waere der Anteil kuenstlich niedrig (fehlende Wallets zaehlen als 0).
        circulating > 0 && real.length >= 1000 ? sumTop(1000) / circulating : null
      )
  );

  // --- 8. Schreiben ------------------------------------------------------
  log("  schreibe " + stmts.length + " Statements ...");
  await batched(db, stmts);

  const ms = Date.now() - t0;
  await db
    .prepare("UPDATE snapshots SET status='ok', changed_count=?, duration_ms=? WHERE id=?")
    .bind(changed, ms, snapId)
    .run();

  // --- 9. Telegram-Weckalarm ---------------------------------------------
  //
  // Laeuft bewusst NACH dem Schreiben, nicht davor: ein haengender Telegram-
  // Call soll niemals verhindern, dass der eigentliche Snapshot durchgeht.
  // Nur ein paar HTTP-Calls fuer frisch erkannte sleeper_wake-Ereignisse -
  // unproblematisch fuer die GitHub Action, die das hier ausfuehrt.
  let telegramVersendet = 0;
  if (env.TELEGRAM_BOT_TOKEN) {
    const wakeEvents = events.filter((e) => e.type === "sleeper_wake");
    try {
      const r = await benachrichtigeSleeperWakes(env, db, wakeEvents, log);
      telegramVersendet = r.versendet;
      if (telegramVersendet) log("  " + telegramVersendet + " Telegram-Weckalarm(e) versendet");
    } catch (e) {
      log("  Telegram-Benachrichtigung fehlgeschlagen: " + e.message);
    }
  }

  log("Snapshot #" + snapId + " fertig in " + (ms / 1000).toFixed(1) + "s");
  return {
    snapshot_id: snapId,
    taken_at: takenAt,
    addresses: rows.length,
    changed,
    dropped: dropped.length,
    events: events.length,
    statements: stmts.length,
    duration_ms: ms,
    bridge_etn: bridgeEtn,
    circulating,
    telegram_versendet: telegramVersendet,
  };
}
