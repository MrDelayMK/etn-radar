// Kern des Trackers: einen Snapshot ziehen, mit dem letzten Stand vergleichen,
// Aenderungen und Ereignisse ableiten, alles in D1 schreiben.
//
// Bewusst umgebungsneutral: bekommt ein `db` mit D1-Interface
// (prepare/bind/all/run/batch). Laeuft dadurch identisch im Worker (native D1)
// und in Node (HTTP-Adapter, siehe src/db-http.js).

import { fetchTopAddresses, fetchStats, fetchTxChart } from "./blockscout.js";
import { tierFor, TIERS } from "./tiers.js";
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

/* ---------- Marker rund um den Migrations-Stichtag ------------------------
 *
 * Der Stichtag kommt genau einmal. Was an diesem Tag gilt - Bridge-Bestand,
 * Kurs, Marktkapitalisierung, Verteilung - laesst sich danach nirgends mehr
 * herholen: der Bridge-Bestand aendert sich weiter, der Kurs sowieso. Also
 * wird der Zustand an festgelegten Tagen eingefroren, jeder Marker genau
 * einmal und danach nie wieder angefasst.
 *
 * Die Abstaende sind bewusst symmetrisch: ein Vergleich von 30 Tagen davor
 * mit 90 Tagen danach misst hauptsaechlich die unterschiedliche Laenge.
 *
 * T-90 faellt auf den 02.11.2026, drei Monate vor den Stichtag. Das ist
 * Absicht - ein Mechanismus, der erst am entscheidenden Tag zum ersten Mal
 * laeuft, ist an diesem Tag kaputt.
 */
const STICHTAG_MARKER = [
  ["T-90", -90], ["T-30", -30], ["T0", 0], ["T+30", 30], ["T+90", 90],
];

// Faellt zurueck auf denselben Wert wie wrangler.toml. Die Variable dort ist
// die Quelle; das hier verhindert nur, dass ein Aufrufer, der sie nicht
// durchreicht, die Marker stillschweigend ausfallen laesst.
const STICHTAG_STANDARD = "2027-01-31";

async function batched(db, statements) {
  let geschrieben = 0;
  for (let i = 0; i < statements.length; i += CHUNK) {
    const res = await db.batch(statements.slice(i, i + CHUNK));
    // Nicht jeder Adapter liefert meta - dann bleibt die Zahl eben 0 und
    // niemand faellt darueber.
    for (const r of res ?? []) geschrieben += r?.meta?.rows_written ?? 0;
  }
  return { anzahl: statements.length, geschrieben };
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
  const [top, stats, txChart] = await Promise.all([
    fetchTopAddresses(env.EXPLORER_API, topN, opts.onProgress),
    fetchStats(env.EXPLORER_API).catch(() => ({})),
    fetchTxChart(env.EXPLORER_API),
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
  // Aber nur, wenn die geholte Liste ueberhaupt vollstaendig aussieht.
  //
  // Beim Test mit einer verkuerzten Liste kam heraus, was sonst passiert
  // waere: 400 statt 3.000 Adressen, und der Lauf markierte 2.601 Wallets als
  // herausgefallen und schrieb ebenso viele "Left top N"-Ereignisse - aus
  // einem reinen Abbruch beim Blaettern. Der naechste vollstaendige Lauf
  // haette sie alle wieder hereingeholt, samt weiterer 2.601 Zeilen. Rund
  // 5 Prozent des Tagesbudgets fuer eine Falschmeldung.
  //
  // Gemessen wird gegen die ANGEFORDERTE Groesse, nicht gegen den letzten
  // Lauf: wer TRACK_TOP_N bewusst herabsetzt, bekommt genau so viele Zeilen
  // wie angefordert und wird davon nicht ausgebremst.
  const seen = new Set(rows.map((r) => r.hash));
  const listeGlaubhaft = bootstrap || rows.length >= topN * 0.8;
  if (!listeGlaubhaft) {
    log(
      "  WARNUNG: nur " + rows.length + " von " + topN + " Adressen geliefert - " +
        "Abgaenge werden diesmal NICHT ausgewertet, sonst gaelten " +
        (prev.size - rows.length) + " Wallets faelschlich als herausgefallen."
    );
  }
  const dropped = !listeGlaubhaft
    ? []
    : [...prev.entries()]
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

  // --- 7b. Kennzahlen fuer die Uebersicht vorberechnen -------------------
  //
  // Diese Zahlen liegen hier ohnehin im Speicher. Frueher rechnete
  // /api/overview sie bei JEDEM Cache-Miss neu aus der Datenbank - dreimal ein
  // voller Durchlauf durch current_balances, gemessene 7.179 gelesene Zeilen,
  // um am Ende zwanzig Zahlen anzuzeigen. Genau daran riss am 08.09.2026 das
  // Tageslimit. Hier abgelegt kostet dasselbe EINE gelesene Zeile.
  //
  // Die Bedingungen muessen exakt die der frueheren Abfragen sein, sonst zeigt
  // die Seite ploetzlich andere Zahlen als vorher:
  //   pro_tier   ueber die BETRAEGE aus TIERS - nicht ueber
  //              current_balances.tier, das ist nur ein Cache und waere nach
  //              einer Schwellenaenderung veraltet. Ohne die Bridge.
  //   grenze     MIT Bridge: die alte Abfrage schloss sie hier nicht aus.
  //   schlaefer  >= 1 Mio ETN, seit SLEEPER_DAYS unbewegt, ohne die Bridge.
  const schnelleTiers = TIERS.filter((t) => !t.census);
  const proTier = {};
  for (const t of schnelleTiers) {
    const i = TIERS.indexOf(t);
    const max = i > 0 ? TIERS[i - 1].min : Infinity;
    const drin = real.filter((r) => r.etn >= t.min && r.etn < max);
    proTier["n_" + t.key] = drin.length;
    proTier["e_" + t.key] = drin.reduce((sum, r) => sum + r.etn, 0);
  }

  // 90 Tage, NICHT SLEEPER_DAYS. Zwei verschiedene Begriffe, die man leicht
  // verwechselt: SLEEPER_DAYS (30) entscheidet, ab wann ein Erwachen ein
  // Ereignis wert ist; die Uebersichts-Kachel zaehlt dagegen seit jeher, was
  // 90 Tage still liegt. Hier muss die Kachel-Definition stehen, sonst zeigt
  // die Seite nach der Umstellung eine andere Zahl als vorher.
  const schlaeferGrenze = Date.now() - 90 * 86400000;
  let schlaeferAnzahl = 0;
  let schlaeferEtn = 0;
  for (const r of real) {
    if (r.etn < 1000000) continue;
    // Nach diesem Lauf steht in updated_at entweder der alte Stand (Balance
    // unveraendert) oder takenAt - und wer sich gerade bewegt hat, schlaeft
    // per Definition nicht.
    const vorher = prev.get(r.hash);
    const stand =
      vorher && vorher.balance_wei === r.balance_wei ? vorher.updated_at : takenAt;
    if (stand && Date.parse(stand) <= schlaeferGrenze) {
      schlaeferAnzahl++;
      schlaeferEtn += r.etn;
    }
  }

  stmts.push(
    db
      .prepare(
        "INSERT INTO kennzahlen (id, daten, snapshot_id, erstellt_am) VALUES (1,?,?,?)" +
          " ON CONFLICT(id) DO UPDATE SET daten=excluded.daten," +
          " snapshot_id=excluded.snapshot_id, erstellt_am=excluded.erstellt_am"
      )
      .bind(
        JSON.stringify({
          pro_tier: proTier,
          grenze: {
            min_etn: rows.reduce((m, r) => (m == null || r.etn < m ? r.etn : m), null),
            anzahl: rows.length,
          },
          schlaefer: { anzahl: schlaeferAnzahl, etn: schlaeferEtn },
          // Fuer die Gesamtzahl im Leaderboard - dieselbe Bedingung wie dort
          // (in den Top N, ohne Bridge), nur ohne die Datenbank zu durchlaufen.
          holder_anzahl: real.length,
          // Netzwerk-Kacheln: frueher holte sie jeder Cache-Miss selbst beim
          // Explorer. Der Cache liegt je Rechenzentrum getrennt, die Last waere
          // also mit der Besucherzahl mitgewachsen. Einmal je Snapshot abgelegt
          // sind es null zusaetzliche Anfragen, egal wie viele zuschauen.
          netz: { stats: stats.roh ?? null, tx_chart: txChart ?? null },
        }),
        snapId,
        takenAt
      )
  );

  // --- 7c. Rang-Historie, einmal am Tag ----------------------------------
  //
  // Fuer "hat die Bewegung auch Plaetze gekostet". Nachtraeglich laesst sich
  // der Rang von damals NICHT rekonstruieren: er verschiebt sich auch dann,
  // wenn ein Wallet selbst nichts tut - bewegt sich jemand darueber, rutscht
  // es ohne eigenes Zutun. Also muss er aufgehoben werden.
  //
  // Einmal je Tag sind das ~3.000 Zeilen, rund 3% des taeglichen
  // Schreibbudgets. Bei jedem Snapshot waeren es 144.000 und damit 144%.
  const rangHeuteDa = await db
    .prepare("SELECT 1 FROM daily_ranks WHERE day = ? LIMIT 1")
    .bind(day)
    .first();
  if (!rangHeuteDa) {
    const insRang = db.prepare(
      "INSERT INTO daily_ranks (address, day, rank_pos) VALUES (?,?,?)" +
        " ON CONFLICT(address, day) DO UPDATE SET rank_pos=excluded.rank_pos"
    );
    for (const r of rows) {
      if (r.rank_pos != null) stmts.push(insRang.bind(r.hash, day, r.rank_pos));
    }
    log("  Rang-Historie fuer " + day + " wird angelegt");
  }

  // --- 7d. Kursmarken fortschreiben --------------------------------------
  //
  // Allzeithoch und -tief kamen einmalig von CoinGecko, weil keine kostenlose
  // Quelle ihre Tagesreihe weiter als 365 Tage zurueck herausgibt (geprueft
  // am 08.09.2026: CoinPaprika 402, CryptoCompare 401, CoinGecko 401 ab dem
  // 366. Tag). Ab hier pflegen wir sie selbst - damit braucht der Betrieb
  // wieder keine fremde Kursquelle, genau wie beim Kursverlauf.
  //
  // Das ist nicht bloss Vorsorge: Das Allzeittief stammt vom August 2026, ist
  // also frisch. Faellt der Kurs erneut darunter, muss die Marke mitgehen,
  // sonst zeigt die Seite ein Tief an, das laengst unterboten wurde.
  if (price != null && Number.isFinite(price)) {
    const marken = (
      await db.prepare("SELECT schluessel, preis FROM kurs_marken").all()
    ).results;
    const stand = Object.fromEntries(marken.map((m) => [m.schluessel, m.preis]));
    const setzeMarke = db.prepare(
      "INSERT INTO kurs_marken (schluessel, preis, tag, quelle, gesetzt_am) VALUES (?,?,?,?,?)" +
        " ON CONFLICT(schluessel) DO UPDATE SET preis=excluded.preis, tag=excluded.tag," +
        " quelle=excluded.quelle, gesetzt_am=excluded.gesetzt_am"
    );
    if (stand.ath == null || price > stand.ath) {
      stmts.push(setzeMarke.bind("ath", price, day, "eigener Snapshot", takenAt));
      log("  neues Allzeithoch: " + price);
    }
    if (stand.atl == null || price < stand.atl) {
      stmts.push(setzeMarke.bind("atl", price, day, "eigener Snapshot", takenAt));
      log("  neues Allzeittief: " + price);
    }
  }

  // 12-Monats-Hoch und -Tief, einmal am Tag zusammen mit der Rang-Historie.
  //
  // Steht hier statt in der Abfrage, weil es sonst bei jedem Seitenaufruf
  // ueber ein Jahr Kurse laufen muesste - 365 gelesene Zeilen fuer zwei
  // Zahlen, die sich taeglich einmal aendern.
  //
  // Beide Quellen zusammen: die nachgeladene Vergangenheit und die eigenen
  // Snapshots, die seither dazugekommen sind.
  if (!rangHeuteDa) {
    const abTag = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const spanne = await db
      .prepare(
        "SELECT max(preis) hoch, min(preis) tief FROM (" +
          "  SELECT day, preis FROM price_history WHERE day >= ?1" +
          "  UNION ALL" +
          "  SELECT substr(taken_at,1,10) AS day, etn_price AS preis FROM snapshots" +
          "   WHERE etn_price IS NOT NULL AND taken_at >= ?1" + // Index statt Vollscan
          ")"
      )
      .bind(abTag)
      .first();
    if (spanne?.hoch != null) {
      const setzeMarke = db.prepare(
        "INSERT INTO kurs_marken (schluessel, preis, tag, quelle, gesetzt_am) VALUES (?,?,?,?,?)" +
          " ON CONFLICT(schluessel) DO UPDATE SET preis=excluded.preis, tag=excluded.tag," +
          " quelle=excluded.quelle, gesetzt_am=excluded.gesetzt_am"
      );
      stmts.push(setzeMarke.bind("hoch_12m", spanne.hoch, day, "eigene Reihe", takenAt));
      if (spanne.tief != null) {
        stmts.push(setzeMarke.bind("tief_12m", spanne.tief, day, "eigene Reihe", takenAt));
      }
    }
  }

  // --- 7e. Stichtags-Marker einfrieren -----------------------------------
  //
  // Ein Marker wird an dem Tag geschrieben, an dem er faellig wird, und nur
  // wenn er noch nicht steht. War der Ingest an dem Tag aus, holt der naechste
  // Lauf ihn nach - mit dem Stand von einem Tag spaeter, was in "tag" auch so
  // steht. Lieber ein Wert mit ehrlichem Datum als gar keiner.
  //
  // Die Zahlen stammen aus diesem Lauf statt aus einer Abfrage: sie liegen
  // hier ohnehin im Speicher und gehoeren alle zum selben Zeitpunkt.
  {
    const stichtag = String(env.MIGRATION_DEADLINE ?? STICHTAG_STANDARD);
    const basis = Date.parse(stichtag + "T00:00:00Z");
    if (Number.isFinite(basis)) {
      const vorhanden = new Set(
        (await db.prepare("SELECT schluessel FROM stichtag").all()).results.map(
          (r) => r.schluessel
        )
      );
      const faellig = STICHTAG_MARKER.filter(([schluessel, versatz]) => {
        if (vorhanden.has(schluessel)) return false;
        // +1 Tag: gemessen wird, wenn der gemeinte Tag VORBEI ist, nicht wenn
        // er anbricht. Der Stichtag 31.01. laeuft bis Mitternacht - wer schon
        // am Morgen des 31. misst, haelt einen Zustand fest, der noch einen
        // ganzen Tag Migration vor sich hat. Der Marker T0 entsteht damit im
        // ersten Lauf des 01.02., und "tag" haelt fest, wann wirklich gemessen
        // wurde.
        const soll = new Date(basis + (versatz + 1) * 86400000).toISOString().slice(0, 10);
        return day >= soll;
      });

      if (faellig.length) {
        const zustand = JSON.stringify({
          bridge_etn: bridgeEtn,
          bridge_wei: bridgeRow?.balance_wei ?? null,
          total_supply: totalSupplyEtn,
          zirkulierend: circulating,
          preis: price,
          // Marktkapitalisierung auf der zirkulierenden Menge, nicht auf der
          // Gesamtmenge: was in der Bridge liegt, ist nicht im Umlauf. Genau
          // diese Unterscheidung ist nach dem Stichtag der ganze Punkt.
          marktkapitalisierung: price != null ? circulating * price : null,
          holder_1m: real.filter((r) => r.etn >= 1000000).length,
          holder_5m: real.filter((r) => r.etn >= 5000000).length,
          holder_10m: real.filter((r) => r.etn >= 10000000).length,
          top10_anteil: circulating > 0 ? sumTop(10) / circulating : null,
          top100_anteil: circulating > 0 ? sumTop(100) / circulating : null,
          adressen_gesamt: top.total_addresses ?? null,
          adressen_erfasst: rows.length,
        });
        const insMarker = db.prepare(
          "INSERT INTO stichtag (schluessel, tag, daten, gesetzt_am) VALUES (?,?,?,?)" +
            " ON CONFLICT(schluessel) DO NOTHING"
        );
        for (const [schluessel] of faellig) {
          stmts.push(insMarker.bind(schluessel, day, zustand, takenAt));
          log("  Stichtags-Marker " + schluessel + " festgehalten (" + day + ")");
        }
      }
    }
  }

  // --- 8. Schreiben ------------------------------------------------------
  log("  schreibe " + stmts.length + " Statements ...");
  const schreib = await batched(db, stmts);
  log("  " + schreib.geschrieben + " Zeilen geschrieben");

  const ms = Date.now() - t0;
  await db
    .prepare(
      "UPDATE snapshots SET status='ok', changed_count=?, duration_ms=?, rows_written=?" +
        " WHERE id=?"
    )
    .bind(changed, ms, schreib.geschrieben, snapId)
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
