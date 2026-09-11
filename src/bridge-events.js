// Grosse Migrations-Ereignisse: an welchen Tagen ist ein ungewoehnlich
// GROSSER Einzelbetrag aus der Bridge geflossen, und an wen?
//
// Grundlage sind die internen Transaktionen der Bridge. Sie sendet ETN
// naemlich nicht ueber normale Top-Level-Transaktionen - die Liste ist dort
// leer (gegengeprueft) -, sondern ausschliesslich ueber interne Transfers
// innerhalb der Contract-Logik.
//
// WARUM NICHT UEBER DIE TAGESBILANZ (erster Ansatz, war falsch):
// Zuerst wurden Ausreisser aus daily_balances bestimmt (Tagesrueckgang >
// 3x Median) und danach die Empfaenger gesucht. Das ergab widerspruechliche
// Zahlen: fuer den 06.08.2026 stand ein Rueckgang von 6.970.369 ETN, waehrend
// an dem Tag nur ein einziger Transfer ueber 3.000.000 ETN lief. Der Rest
// stammte vom Vortag - die Tagesgrenze von `coin-balance-history-by-day`
// stimmt nicht mit der Tagesgrenze der Zeitstempel ueberein. Kopfzahl und
// Empfaengerliste passten dadurch grundsaetzlich nicht zusammen.
//
// WARUM NICHT MEHR NUR 90 TAGE (zweiter Ansatz, war zu kurz):
// Grosse Einzeltransfers sind selten - in drei Monaten zehn Stueck. Ein
// Fenster von 90 Tagen zeigt also fast nichts, waehrend die interessante
// Frage "was waren die groessten Migrationen ueberhaupt" unbeantwortet blieb.
//
// WIE ES JETZT LAEUFT:
// Die Bridge existiert seit dem 03.03.2024, und ihre Transferliste ist nur
// von der neuesten Seite aus rueckwaerts durchblaetterbar. Ein Durchgang ueber
// die ganze Historie braucht mehrere Laeufe - jede Woche von vorn waere Unfug
// und gegenueber dem Explorer unhoeflich. Darum:
//
//   1. Die grossen Transfers landen roh in `bridge_transfers`. Der Schluessel
//      ist aus Transaktion, Empfaenger und Betrag gebaut, also ist ein
//      zweites Einlesen derselben Zeile folgenlos.
//   2. `bridge_scan` merkt sich den Cursor des Explorers. Der naechste Lauf
//      macht exakt dort weiter, wo dieser aufgehoert hat.
//   3. Jeder Lauf schaut ausserdem oben nach, was seit dem letzten Mal neu
//      dazugekommen ist.
//   4. `bridge_events` wird am Ende jedes Laufs aus dem Rohbestand neu
//      aufgebaut. Damit ist die Kopfzahl eines Tages per Konstruktion die
//      Summe der Transfers, die darunter stehen.

import { fetchInternalTransactions, fetchAddress } from "./blockscout.js";
import { haeppchenFalten, obenFalten, tagVon, uebertragLesen, uebertragText } from "./bridge-tage.js";

// Ab welchem Einzelbetrag ein Transfer ueberhaupt interessant ist. Darunter
// ist es Alltagsverkehr: an einem beliebigen Tag laufen hunderte kleine
// Migrationen, die niemand einzeln sehen will.
const MIN_TRANSFER_ETN = 500000;

// Wie viele Tage in `bridge_events` gehalten werden. Die Oberflaeche zeigt
// zwoelf; der Rest ist Reserve, damit ein Tag nicht gleich verschwindet, wenn
// weiter hinten in der Historie ein groesserer auftaucht.
const MAX_TAGE = 40;

// Zeitbudget fuer den Weg zurueck in die Historie, in Minuten. Bei rund
// 2,7 Seiten pro Sekunde (Drossel siehe src/blockscout.js) sind 130 Minuten
// etwa 21.000 Seiten. Die ganze Historie braucht wenige solcher Laeufe;
// danach kostet ein Lauf nur noch die paar Seiten seit dem letzten Mal.
// Obergrenze ist das Zeitlimit des Workflows (150 Minuten): dazu kommen noch
// der Blick nach oben und das Neuaufbauen der Ereignisse.
const STD_BUDGET_MINUTEN = 130;

// Deckel fuer den Blick nach oben (was ist seit dem letzten Lauf neu). Eine
// Woche Bridge-Verkehr sind je nach Andrang 15 bis 100 Seiten.
const NACHLAUF_SEITEN = 400;

// In wie grossen Haeppchen die Historie abgearbeitet wird.
//
// Der Weg zurueck dauert Stunden. Wuerde erst am Ende geschrieben, waere ein
// Abbruch bei Minute 95 - Zeitlimit, Aussetzer beim Explorer, abgebrochener
// Lauf - komplett verloren, und der naechste Lauf finge an derselben Stelle
// wieder an. Nach jedem Haeppchen werden darum die gefundenen Transfers UND
// der Cursor festgehalten. Schlimmstenfalls gehen die paar hundert Seiten des
// laufenden Haeppchens verloren.
const HAEPPCHEN_SEITEN = 400;

/** Schluessel einer Transferzeile - zweimal einlesen aendert nichts. */
const schluessel = (t) => t.hash + ":" + t.to + ":" + t.value_wei;

/**
 * @param {object} env  { EXPLORER_API, BRIDGE_ADDRESS, BRIDGE_SCAN_MINUTEN }
 * @param {object} db   D1-kompatible Datenbank
 */
export async function runBridgeEventAnalysis(env, db, opts = {}) {
  const log = opts.log ?? (() => {});
  const api = env.EXPLORER_API;
  const bridge = String(env.BRIDGE_ADDRESS).toLowerCase();
  const schwelle = opts.schwelle ?? MIN_TRANSFER_ETN;
  const budgetMs =
    (opts.budgetMinuten || Number(env.BRIDGE_SCAN_MINUTEN) || STD_BUDGET_MINUTEN) * 60000;
  const jetzt = new Date().toISOString();

  const stand = (await db.prepare("SELECT * FROM bridge_scan WHERE id = 1").first()) ?? {
    neuestes_bekannt: null,
    aeltestes_bekannt: null,
    cursor: null,
    fertig: 0,
    seiten_gesamt: 0,
  };

  // Die Tagessummen (bridge_tage) kamen erst nach den ersten Durchgaengen dazu.
  // Steht schon ein Cursor, aber noch keine einzige Tagessumme, fehlen sie genau
  // fuer das bereits gelesene Stueck - und ein Lauf, der nur weitermacht, fuellte
  // diese Luecke nie. Dann von vorn. Die grossen Transfers kommen dabei
  // unveraendert wieder heraus, ihr Schluessel verhindert Doppelte.
  const tageDa = await db.prepare("SELECT 1 FROM bridge_tage LIMIT 1").first();
  if (!tageDa && (stand.cursor || stand.fertig || stand.neuestes_bekannt)) {
    log("Noch keine Tagessummen vorhanden - der Durchgang beginnt von vorn.");
    Object.assign(stand, {
      neuestes_bekannt: null, aeltestes_bekannt: null, cursor: null,
      fertig: 0, seiten_gesamt: 0, uebertrag: null,
    });
  }
  let uebertrag = uebertragLesen(stand.uebertrag);

  // Bestand der Bridge zu Beginn des Laufs: der Anker, von dem aus die
  // Tagessummen rueckwaerts zu einem Bestandsverlauf werden. Eine Anfrage je
  // Lauf. Geholt VOR dem Blick nach oben - was waehrenddessen noch abfliesst,
  // zaehlt schlimmstenfalls ein paar Sekunden Verkehr zu viel zum heutigen Tag.
  let ankerWei = stand.anker_wei ?? null;
  let ankerZeit = stand.anker_zeit ?? null;
  try {
    const a = await fetchAddress(api, bridge);
    if (a?.balance_wei != null) {
      ankerWei = String(a.balance_wei);
      ankerZeit = new Date().toISOString();
    }
  } catch (e) {
    log("  Bridge-Bestand nicht abrufbar (" + e.message + ") - der bisherige Anker bleibt.");
  }

  const insTag = db.prepare(
    "INSERT INTO bridge_tage (day, abfluss_wei, abfluss_anzahl, zufluss_wei) VALUES (?,?,?,?)" +
      " ON CONFLICT(day) DO UPDATE SET abfluss_wei=excluded.abfluss_wei," +
      "   abfluss_anzahl=excluded.abfluss_anzahl, zufluss_wei=excluded.zufluss_wei"
  );
  const tageSchreiben = async (tage) => {
    if (!tage.length) return;
    await db.batch(
      tage.map((t) =>
        insTag.bind(t.day, String(t.abfluss_wei), t.abfluss_anzahl, String(t.zufluss_wei))
      )
    );
  };

  let seiten = 0;
  let neueTransfers = 0;
  let neuestes = stand.neuestes_bekannt;
  let aeltestes = stand.aeltestes_bekannt;

  /** Grosse Transfers wegschreiben, kleine verwerfen. */
  const speichern = async (transfers) => {
    const gross = transfers.filter((t) => t.etn >= schwelle);
    if (!gross.length) return 0;
    const ins = db.prepare(
      "INSERT INTO bridge_transfers (id, day, timestamp, to_address, etn, value_wei)" +
        " VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING"
    );
    for (const t of gross) {
      await ins
        .bind(schluessel(t), t.timestamp.slice(0, 10), t.timestamp, t.to, t.etn, t.value_wei)
        .run();
    }
    return gross.length;
  };

  const spanne = (transfers) => {
    for (const t of transfers) {
      if (!neuestes || t.timestamp > neuestes) neuestes = t.timestamp;
      if (!aeltestes || t.timestamp < aeltestes) aeltestes = t.timestamp;
    }
  };

  // --- 1. Was ist oben neu dazugekommen? --------------------------------
  //
  // Nur sinnvoll, wenn ueberhaupt schon einmal gelesen wurde - beim ersten
  // Lauf faengt Schritt 2 ohnehin bei der neuesten Seite an.
  if (stand.neuestes_bekannt) {
    log("Neues seit " + stand.neuestes_bekannt.slice(0, 16) + " einsammeln ...");
    // Zurueck bis vor den ANFANG des Tages des letzten bekannten Transfers,
    // nicht nur bis zu diesem Transfer: nur dann ist dieser Tag danach
    // vollstaendig gelesen und laesst sich neu auszaehlen statt zu ergaenzen.
    // Eine Sekunde davor, damit auch ein Transfer genau um Mitternacht, der auf
    // die naechste Seite gerutscht ist, noch mitkommt.
    const abTag = tagVon(stand.neuestes_bekannt);
    const r = await fetchInternalTransactions(api, bridge, {
      maxPages: NACHLAUF_SEITEN,
      bisZeit: new Date(Date.parse(abTag + "T00:00:00Z") - 1000).toISOString(),
    });
    seiten += r.seiten;
    neueTransfers += await speichern(r.transfers);
    spanne(r.transfers);

    const aeltesterTag = r.transfers.reduce(
      (m, t) => (m == null || tagVon(t.timestamp) < m ? tagVon(t.timestamp) : m),
      null
    );
    const vollstaendig =
      !r.cursor || r.seiten < NACHLAUF_SEITEN || (aeltesterTag != null && aeltesterTag < abTag);
    await tageSchreiben(obenFalten(r.transfers, bridge, abTag, vollstaendig));
    if (!vollstaendig) {
      // Mehr neuer Verkehr, als der Deckel hergibt. Der neue Anker wuerde dann
      // auf Tagessummen stehen, die nicht lueckenlos an die alten anschliessen -
      // lieber der alte Anker und ein Verlauf, der ein paar Tage frueher endet.
      log("  Mehr als " + NACHLAUF_SEITEN + " Seiten neuer Verkehr - die Tagessummen reichen nicht" +
        " lueckenlos bis " + abTag + " zurueck, der Anker bleibt beim letzten Lauf.");
      ankerWei = stand.anker_wei ?? null;
      ankerZeit = stand.anker_zeit ?? null;
    }
    log("  " + r.seiten + " Seiten, " + r.transfers.length + " Transfers angesehen");
  }

  // --- 2. Weiter zurueck in die Historie --------------------------------
  //
  // Fertig ist der Durchgang erst, wenn der Explorer keine weitere Seite mehr
  // hat - dann steht auch kein Cursor mehr da. Vom 10. bis 11.09.2026 hoerte
  // der Durchgang schon beim 01.01.2026 auf und markierte sich dabei als
  // fertig, behielt aber den Cursor. Ein solcher Stand ist eine Pause, kein
  // Ende, und setzt hier genau dort fort.
  let fertig = stand.fertig && !stand.cursor ? 1 : 0;
  let cursor = stand.cursor ? JSON.parse(stand.cursor) : null;

  const zustandSchreiben = () =>
    db
      .prepare(
        "INSERT INTO bridge_scan (id, neuestes_bekannt, aeltestes_bekannt, cursor, fertig," +
          " seiten_gesamt, aktualisiert_am, uebertrag, anker_wei, anker_zeit)" +
          " VALUES (1,?,?,?,?,?,?,?,?,?)" +
          " ON CONFLICT(id) DO UPDATE SET neuestes_bekannt=excluded.neuestes_bekannt," +
          "   aeltestes_bekannt=excluded.aeltestes_bekannt, cursor=excluded.cursor," +
          "   fertig=excluded.fertig, seiten_gesamt=excluded.seiten_gesamt," +
          "   aktualisiert_am=excluded.aktualisiert_am, uebertrag=excluded.uebertrag," +
          "   anker_wei=excluded.anker_wei, anker_zeit=excluded.anker_zeit"
      )
      .bind(
        neuestes,
        aeltestes,
        cursor ? JSON.stringify(cursor) : null,
        fertig,
        (stand.seiten_gesamt ?? 0) + seiten,
        new Date().toISOString(),
        uebertragText(uebertrag),
        ankerWei,
        ankerZeit
      )
      .run();

  // Nach dem Blick nach oben schon einmal sichern - der hat ja auch Zeit
  // gekostet.
  await zustandSchreiben();

  if (!fertig) {
    log(
      (cursor ? "Historie fortsetzen" : "Historie beginnen") +
        " (Budget " + Math.round(budgetMs / 60000) + " Minuten, " +
        HAEPPCHEN_SEITEN + " Seiten je Haeppchen) ..."
    );
    let rest = budgetMs;
    while (!fertig && rest > 0) {
      const t0 = Date.now();

      // Ein Fehler im Haeppchen beendet den Durchgang, ohne ihn scheitern zu
      // lassen: der Stand bis hierher ist gespeichert, der naechste Lauf
      // setzt dort fort. Vorher schlug ein Aussetzer beim Explorer bis nach
      // oben durch - genau daran ist der erste grosse Durchgang nach 68
      // Minuten gestorben, und weil damals erst am Ende geschrieben wurde,
      // war die ganze Zeit verloren.
      let r;
      try {
        r = await fetchInternalTransactions(api, bridge, {
          maxPages: HAEPPCHEN_SEITEN,
          startCursor: cursor,
          fristMs: rest,
        });
      } catch (e) {
        log("  Abbruch beim Blaettern: " + e.message);
        log("  Der Stand ist gesichert - der naechste Lauf macht dort weiter.");
        break;
      }
      if (!r.seiten) break;
      seiten += r.seiten;
      neueTransfers += await speichern(r.transfers);
      spanne(r.transfers);
      // Tagessummen VOR dem Cursor. Bricht der Lauf dazwischen ab, liest der
      // naechste dasselbe Haeppchen mit demselben Uebertrag noch einmal und
      // ueberschreibt mit denselben Zahlen (siehe src/bridge-tage.js).
      const gefaltet = haeppchenFalten(r.transfers, bridge, uebertrag, !r.cursor);
      await tageSchreiben(gefaltet.fertig);
      uebertrag = gefaltet.uebertrag;
      cursor = r.cursor;
      fertig = r.cursor ? 0 : 1;
      await zustandSchreiben();
      rest -= Date.now() - t0;
      log(
        "  " + seiten + " Seiten gesamt, zurueck bis " +
          (aeltestes ? aeltestes.slice(0, 10) : "—") +
          ", noch " + Math.max(0, Math.round(rest / 60000)) + " Minuten Budget"
      );
    }
    log(
      fertig
        ? "  Anfang der Bridge erreicht - die Historie ist vollstaendig."
        : "  Budget aufgebraucht, der Rest kommt beim naechsten Lauf."
    );
  } else {
    log("Historie ist vollstaendig erfasst - nur der Blick nach oben war noetig.");
  }

  // --- 3. Die Anzeige-Tabelle aus dem Rohbestand neu aufbauen -----------
  //
  // Immer komplett neu statt zu ergaenzen: der Rohbestand ist die einzige
  // Wahrheit, und so kann die Tagesbilanz gar nicht von den Transfers
  // abweichen, aus denen sie sich zusammensetzt.
  const tage = (
    await db
      .prepare(
        "SELECT day, sum(etn) AS summe, count(*) AS anzahl FROM bridge_transfers" +
          " GROUP BY day ORDER BY summe DESC LIMIT ?"
      )
      .bind(MAX_TAGE)
      .all()
  ).results;

  await db.prepare("DELETE FROM bridge_events").run();

  if (tage.length) {
    const platzhalter = tage.map(() => "?").join(",");
    const empfaenger = (
      await db
        .prepare(
          "SELECT day, to_address, etn FROM bridge_transfers WHERE day IN (" + platzhalter + ")" +
            " ORDER BY etn DESC"
        )
        .bind(...tage.map((t) => t.day))
        .all()
    ).results;

    const proTag = new Map();
    for (const e of empfaenger) {
      if (!proTag.has(e.day)) proTag.set(e.day, []);
      const liste = proTag.get(e.day);
      if (liste.length < 10) liste.push({ address: e.to_address, etn: e.etn });
    }

    const ins = db.prepare(
      "INSERT INTO bridge_events (day, outflow_etn, recipient_count, top_recipients," +
        " unvollstaendig, analyzed_at) VALUES (?,?,?,?,0,?)"
    );
    for (const t of tage) {
      await ins
        .bind(t.day, t.summe, t.anzahl, JSON.stringify(proTag.get(t.day) ?? []), jetzt)
        .run();
    }
  }

  const gesamt = (await db.prepare("SELECT count(*) AS n FROM bridge_transfers").first())?.n ?? 0;
  log(
    "Rohbestand: " + gesamt + " grosse Transfers, daraus " + tage.length + " Ereignistage" +
      (neueTransfers ? " (" + neueTransfers + " in diesem Lauf neu)" : "")
  );

  await db
    .prepare(
      "INSERT INTO bridge_event_runs (taken_at, day, tage_gefunden, tage_analysiert, zurueck_bis, status)" +
        " VALUES (?,?,?,?,?,?)"
    )
    .bind(
      jetzt,
      jetzt.slice(0, 10),
      tage.length,
      tage.length,
      aeltestes ? aeltestes.slice(0, 10) : null,
      fertig ? "ok" : "partial"
    )
    .run();

  return {
    seiten,
    neue_transfers: neueTransfers,
    grosse_transfers_gesamt: gesamt,
    ereignistage: tage.length,
    zurueck_bis: aeltestes ? aeltestes.slice(0, 10) : null,
    historie_vollstaendig: !!fertig,
  };
}
