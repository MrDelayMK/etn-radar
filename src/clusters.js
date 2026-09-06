// Cluster-Vermutungen: welche Wallets koennten derselben Person/Gruppe
// gehoeren?
//
// WICHTIG - was das hier NICHT ist: kein Beweis, keine Identitaet, keine
// Zuordnung zu einer echten Person. Nur ein einziges Signal wird ausgewertet:
// eine gemeinsame Finanzierungsquelle. Auf Ethereum/EVM-Chains (anders als
// Bitcoin) gibt es keine "Common-Input-Ownership"-Heuristik, die eine
// verlaessliche Zuordnung erlauben wuerde - siehe die Erklaerung in der
// README. Das Ergebnis ist ein Muster, keine Behauptung, und wird im
// Dashboard auch nur so angezeigt (eigener Tab, klar als Vermutung markiert,
// nie im Leaderboard).
//
// Quelle ausschliesslich blockexplorer.electroneum.com (siehe
// src/blockscout.js, fetchInboundTransactions) - keine Daten von Drittseiten.
//
// Methode pro Wallet:
//   1. Bis zu MAX_PAGES Seiten eingehender Transaktionen holen (neueste zuerst).
//   2. Nach Absender gruppieren, den groessten Anteil am erhaltenen Betrag finden.
//   3. War die Historie laenger als MAX_PAGES (gedeckelt), wird das Ergebnis
//      verworfen statt aus einem unvollstaendigen Ausschnitt geraten - genau
//      das trifft ohnehin meist auf Boersen/Dienste zu, keine Cluster-Kandidaten.
// Cluster entstehen anschliessend aus Wallets, die dieselbe Finanzierungsquelle
// mit hohem Anteil teilen (siehe clusterGruppen unten).

import { fetchInboundTransactions } from "./blockscout.js";

const MAX_PAGES = 6; // 6 * 50 = 300 Transaktionen pro Wallet
const MIN_ANTEIL = 0.6; // Quelle muss mindestens 60% des Empfangenen stellen
const MIN_GRUPPE = 2; // ab wie vielen Wallets ein "Cluster" gemeldet wird
// Nur die groessten Wallets analysieren: schneller, weniger API-Last, und
// genau dort liegen die Cluster, die ueberhaupt interessant sind - zwei
// $50-Wallets mit gemeinsamer Quelle sind kein nennenswerter Fund.
const TOP_N_STANDARD = 1000;

/**
 * @param {object} env  { EXPLORER_API, BRIDGE_ADDRESS }
 * @param {object} db   D1-kompatible Datenbank
 * @param {object} opts { parallel, limit, log, onProgress }
 */
export async function runClusterAnalysis(env, db, opts = {}) {
  const log = opts.log ?? (() => {});
  const parallel = opts.parallel ?? 3;
  const api = env.EXPLORER_API;
  const bridge = String(env.BRIDGE_ADDRESS ?? "").toLowerCase();

  // Nur die individuell verfolgten (Fast-Tier-)Wallets: fuer Census-Stufen
  // liegen keine Einzeldaten vor, und bekannte Boersen/die Bridge sind selbst
  // Finanzierungsquellen fuer tausende Wallets, keine Cluster-Mitglieder.
  const todo = (
    await db
      .prepare(
        "SELECT c.address FROM current_balances c LEFT JOIN addresses a ON a.hash = c.address" +
          " WHERE c.in_top_n = 1 AND c.address != ?" +
          " AND COALESCE(a.is_excluded,0) = 0 AND COALESCE(a.label_type,'') != 'exchange'" +
          " ORDER BY c.etn DESC LIMIT ?"
      )
      .bind(bridge, opts.limit ?? TOP_N_STANDARD)
      .all()
  ).results;

  log(todo.length + " Wallets zu analysieren (parallel: " + parallel + ")");
  if (todo.length === 0) return { done: 0, gefunden: 0, gedeckelt: 0, failed: 0 };

  // Boersen und die Bridge zaehlen NICHT als Finanzierungsquelle - nicht nur
  // als Kandidaten (das war schon ausgeschlossen), sondern auch als
  // moeglicher "from"-Absender. Sonst waeren alle Kunden derselben Boerse
  // faelschlich "ein Cluster", weil sie zufaellig von dort abgehoben haben -
  // das ist keine Beziehung zwischen den Wallets, sondern reines Rauschen.
  const keineQuelle = new Set([bridge]);
  for (const r of (
    await db.prepare("SELECT hash FROM addresses WHERE label_type IN ('exchange','bridge')").all()
  ).results) {
    keineQuelle.add(r.hash);
  }
  log("  " + keineQuelle.size + " bekannte Boersen/Bridge als Quelle ausgeschlossen");

  const upsert = db.prepare(
    "INSERT INTO wallet_funding (address, funding_source, funding_share, inbound_wei_total," +
      " inbound_count, pages_checked, capped, computed_at)" +
      " VALUES (?,?,?,?,?,?,?,?)" +
      " ON CONFLICT(address) DO UPDATE SET" +
      "   funding_source = excluded.funding_source, funding_share = excluded.funding_share," +
      "   inbound_wei_total = excluded.inbound_wei_total, inbound_count = excluded.inbound_count," +
      "   pages_checked = excluded.pages_checked, capped = excluded.capped," +
      "   computed_at = excluded.computed_at"
  );

  const state = { done: 0, gefunden: 0, gedeckelt: 0, failed: 0 };
  const t0 = Date.now();
  const queue = [...todo];
  const jetzt = new Date().toISOString();

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;
      try {
        const { transfers, seiten, gedeckelt } = await fetchInboundTransactions(api, row.address, {
          maxPages: MAX_PAGES,
        });

        // Selbst-Ueberweisungen (from === Wallet selbst, z.B. 0-Wert-Aufrufe an
        // sich selbst) sind kein Finanzierungssignal und wuerden bei einem
        // Wallet mit sonst nur wenigen Eingaengen faelschlich als "Quelle =
        // sich selbst" auftauchen. Eingaenge von Boersen/der Bridge zaehlen
        // ebenfalls nicht (siehe keineQuelle oben). Beide werden vor der
        // Auswertung herausgefiltert - NICHT erst am Ergebnis, sonst wuerde
        // ein Wallet mit z.B. 90% Boersen-Einzahlung und 10% echter Quelle
        // faelschlich als "keine klare Quelle" statt richtig ausgewertet.
        const echte = transfers.filter((t) => t.from !== row.address && !keineQuelle.has(t.from));

        let quelle = null;
        let anteil = null;
        let gesamtWei = 0n;
        if (echte.length > 0) {
          const proQuelle = new Map();
          gesamtWei = echte.reduce((s, t) => s + BigInt(t.value_wei), 0n);
          for (const t of echte) {
            proQuelle.set(t.from, (proQuelle.get(t.from) ?? 0n) + BigInt(t.value_wei));
          }
          let bester = null;
          for (const [addr, wei] of proQuelle) {
            if (!bester || wei > bester[1]) bester = [addr, wei];
          }
          quelle = bester[0];
          anteil = gesamtWei > 0n ? Number(bester[1]) / Number(gesamtWei) : 0;
        }
        // Nur eine ECHTE Bewegung > 0 gilt als Finanzierungssignal.
        if (gesamtWei === 0n) quelle = null;

        // Gedeckelte Ergebnisse (mehr Historie vorhanden als geprueft) werden
        // NICHT gespeichert, statt aus einem unvollstaendigen Ausschnitt zu
        // schliessen - konsistent mit dem Rest des Projekts (siehe
        // delta_sicher in src/index.js): lieber "kein Ergebnis" als falsch.
        if (!gedeckelt && quelle) {
          await upsert
            .bind(row.address, quelle, anteil, gesamtWei.toString(), transfers.length, seiten, 0, jetzt)
            .run();
          state.gefunden++;
        } else {
          await db.prepare("DELETE FROM wallet_funding WHERE address = ?").bind(row.address).run();
          if (gedeckelt) state.gedeckelt++;
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
      " geprueft, " + state.gefunden + " mit Finanzierungsquelle, " +
      state.gedeckelt + " zu aktiv (uebersprungen), " + state.failed + " Fehler"
  );

  await db
    .prepare(
      "INSERT INTO cluster_runs (taken_at, day, wallets_geprueft, quellen_gefunden," +
        " zu_aktiv, duration_ms, status) VALUES (?,?,?,?,?,?,?)"
    )
    .bind(jetzt, jetzt.slice(0, 10), state.done, state.gefunden, state.gedeckelt, ms, "ok")
    .run();

  return state;
}

/**
 * Gruppiert die gespeicherten Finanzierungsquellen zu Cluster-Vermutungen.
 * Reine Leseoperation ueber bereits vorhandene wallet_funding-Zeilen - wird
 * live bei jeder API-Anfrage berechnet, kein separater Speicherzustand.
 */
export async function clusterGruppen(db, minAnteil = MIN_ANTEIL, minGroesse = MIN_GRUPPE) {
  const rows = (
    await db
      .prepare(
        "SELECT wf.address, wf.funding_source, wf.funding_share, wf.inbound_wei_total," +
          " wf.computed_at, c.etn, c.tier, a.label, a.ens_name" +
          " FROM wallet_funding wf" +
          " JOIN current_balances c ON c.address = wf.address" +
          " LEFT JOIN addresses a ON a.hash = wf.address" +
          " WHERE wf.funding_share >= ? AND c.in_top_n = 1" +
          " ORDER BY wf.funding_source"
      )
      .bind(minAnteil)
      .all()
  ).results;

  const gruppen = new Map();
  for (const r of rows) {
    if (!gruppen.has(r.funding_source)) gruppen.set(r.funding_source, []);
    gruppen.get(r.funding_source).push(r);
  }

  // Kontext zur Finanzierungsquelle selbst mitliefern: Label (z.B. "KuCoin"),
  // falls bekannt, UND ob sie selbst ein verfolgtes Top-Wallet ist (dann ist
  // sie vermutlich keine anonyme Adresse, sondern z.B. ein grosser Holder,
  // der an mehrere eigene Wallets verteilt hat).
  const quellen = [...gruppen.keys()];
  let quellLabels = {}, quellBalances = {};
  if (quellen.length) {
    const platzhalter = quellen.map(() => "?").join(",");
    quellLabels = Object.fromEntries(
      (
        await db
          .prepare("SELECT hash, label, label_type FROM addresses WHERE hash IN (" + platzhalter + ")")
          .bind(...quellen)
          .all()
      ).results.map((r) => [r.hash, r])
    );
    quellBalances = Object.fromEntries(
      (
        await db
          .prepare(
            "SELECT address, rank_pos, etn, tier FROM current_balances" +
              " WHERE address IN (" + platzhalter + ") AND in_top_n=1"
          )
          .bind(...quellen)
          .all()
      ).results.map((r) => [r.address, r])
    );
  }

  return [...gruppen.entries()]
    .filter(([, mitglieder]) => mitglieder.length >= minGroesse)
    .map(([quelle, mitglieder]) => ({
      funding_source: quelle,
      funding_source_label: quellLabels[quelle]?.label ?? null,
      funding_source_type: quellLabels[quelle]?.label_type ?? null,
      // Ist die Quelle selbst ein verfolgtes Top-Wallet? Dann eher "grosser
      // Holder verteilt an eigene Unterkonten" als eine anonyme Sammelstelle.
      funding_source_rank: quellBalances[quelle]?.rank_pos ?? null,
      funding_source_etn: quellBalances[quelle]?.etn ?? null,
      funding_source_tier: quellBalances[quelle]?.tier ?? null,
      mitglieder: mitglieder.length,
      kombiniert_etn: mitglieder.reduce((s, m) => s + m.etn, 0),
      durchschnitt_anteil: mitglieder.reduce((s, m) => s + m.funding_share, 0) / mitglieder.length,
      wallets: mitglieder
        .sort((a, b) => b.etn - a.etn)
        .map((m) => ({
          address: m.address,
          anzeige: m.label ?? m.ens_name ?? null,
          etn: m.etn,
          tier: m.tier,
          funding_share: m.funding_share,
        })),
    }))
    .sort((a, b) => b.kombiniert_etn - a.kombiniert_etn);
}
