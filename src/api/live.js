// Live-Abrufe beim Explorer, die Besucher ausloesen - mit Sperren und Minutenbudget.

import { fetchAddress } from "../blockscout.js";

/* ---------- Live-Abfrage einzelner Wallets ------------------------------
 *
 * Wer ein Wallet aufschlaegt, soll den Bestand von JETZT sehen, nicht den vom
 * letzten Snapshot. Das kostet genau eine Anfrage an den Explorer - gegen die
 * ~2.900 taeglichen des Snapshot-Laufs ist das Rauschen, und es faellt nur an,
 * wenn wirklich jemand hinschaut.
 *
 * Zwei Sperren, beide ueber die Tabelle live_abrufe:
 *
 *   je Wallet   Innerhalb von LIVE_SPERRE_MS kein zweites Mal. Oeffnen hundert
 *               Leute denselben geteilten Link, kostet das EINE Anfrage.
 *   global      Hoechstens LIVE_PRO_MINUTE fuer die ganze Seite.
 *
 * Die Sperren stehen in D1 und nicht im Cache: Der Cache liegt je
 * Rechenzentrum getrennt, ein Deckel darin waere keiner. Die Datenbank ist
 * eine Instanz - hier gilt die Grenze wirklich global, auch bei zehntausend
 * Besuchern. Mehr Andrang heisst dann nicht mehr Last fuer den Explorer von
 * Electroneum, sondern nur oefter den gespeicherten statt einen frischen Wert.
 *
 * Greift eine Sperre, ist das kein Fehler: Dann zeigt die Seite den Stand aus
 * der Datenbank - der oft selbst erst Sekunden alt ist, weil der letzte
 * Live-Abruf zurueckgeschrieben wurde.
 */
const LIVE_SPERRE_MS = 60000;
const LIVE_PRO_MINUTE = 4;

export async function liveBestand(db, env, adr, bekannt) {
  const jetzt = Date.now();
  try {
    const eigen = await db
      .prepare("SELECT geholt_am FROM live_abrufe WHERE address = ?")
      .bind(adr)
      .first();
    if (eigen && jetzt - Date.parse(eigen.geholt_am) < LIVE_SPERRE_MS) return null;

    const zaehler = await db
      .prepare("SELECT count(*) n FROM live_abrufe WHERE geholt_am >= ?")
      .bind(new Date(jetzt - 60000).toISOString())
      .first();
    if ((zaehler?.n ?? 0) >= LIVE_PRO_MINUTE) return null;

    const frisch = await fetchAddress(env.EXPLORER_API, adr);
    if (!frisch || frisch.balance_wei == null) return null;
    const zeit = new Date(jetzt).toISOString();

    const geaendert = String(bekannt?.balance_wei ?? "") !== String(frisch.balance_wei);
    const schreiben = [
      db
        .prepare(
          "INSERT INTO live_abrufe (address, geholt_am) VALUES (?,?)" +
            " ON CONFLICT(address) DO UPDATE SET geholt_am=excluded.geholt_am"
        )
        .bind(adr, zeit),
    ];

    if (geaendert) {
      // Bestand ja, Rang NEIN: Der Rang ergibt sich aus dem Vergleich mit
      // allen anderen, und die stehen noch auf dem Stand des letzten
      // Snapshots. Ihn hier mitzuziehen ergaebe eine Rangliste, in der zwei
      // Wallets denselben Platz belegen. Er wird beim naechsten Lauf richtig.
      //
      // updated_at nur bei echter Aenderung: Die Spalte markiert die letzte
      // BEWEGUNG und ist die Grundlage der Schlaefer-Erkennung. Sie bei jedem
      // Hinsehen fortzuschreiben wuerde ausgerechnet die Kernfrage des
      // Trackers zerstoeren - welche lange stillen Wallets aufwachen.
      schreiben.push(
        db
          .prepare(
            "UPDATE current_balances SET balance_wei = ?, etn = ?, updated_at = ?" +
              " WHERE address = ?"
          )
          .bind(String(frisch.balance_wei), frisch.etn, zeit, adr)
      );
    }
    await db.batch(schreiben);

    return { balance_wei: String(frisch.balance_wei), etn: frisch.etn, geholt_am: zeit };
  } catch {
    // Explorer stumm, Sperre nicht lesbar, was auch immer: Der gespeicherte
    // Stand ist immer noch eine gute Antwort. Nie deshalb die Seite brechen.
    return null;
  }
}

/* ---------- Minutenbudget fuer Explorer-Abrufe von Besuchern ---------------
 *
 * Die Suche nach einer unbekannten Adresse und der Money Flow fragen live beim
 * Explorer an - der Money Flow bis zu zwanzig Seiten je Klick. Ohne Deckel
 * koennte ein Skript ueber diese Seite tausende Anfragen ausloesen, und beim
 * Explorer saehe es aus, als spammten wir. Darum ein gemeinsames Budget je
 * Minute fuer die ganze Seite, in D1 gezaehlt (siehe liveBestand, warum nicht
 * im Cache). Ist es aufgebraucht, bekommt der Besucher "in einer Minute
 * nochmal" statt einer Anfrage mehr beim Explorer.
 */
const LIVE_BUDGET_PRO_MINUTE = 60;

/**
 * Reserviert `kosten` Explorer-Anfragen. Gibt die Buchungsnummer zurueck oder
 * null, wenn das Budget der letzten Minute aufgebraucht ist.
 */
export async function liveBudget(db, art, kosten) {
  const jetzt = Date.now();
  try {
    const bisher = await db
      .prepare("SELECT COALESCE(sum(kosten), 0) n FROM live_budget WHERE ts >= ?")
      .bind(new Date(jetzt - 60000).toISOString())
      .first();
    if ((bisher?.n ?? 0) + kosten > LIVE_BUDGET_PRO_MINUTE) return null;
    const [eingefuegt] = await db.batch([
      db.prepare("INSERT INTO live_budget (ts, art, kosten) VALUES (?,?,?)")
        .bind(new Date(jetzt).toISOString(), art, kosten),
      // Gebraucht wird nur die letzte Minute; ueber den Index liest das kaum Zeilen.
      db.prepare("DELETE FROM live_budget WHERE ts < ?").bind(new Date(jetzt - 3600000).toISOString()),
    ]);
    return eingefuegt?.meta?.last_row_id ?? -1;
  } catch {
    // Budget nicht lesbar (Tabelle fehlt, D1 stumm): nicht deswegen die Seite
    // brechen. Ist D1 wirklich weg, scheitert der Abruf ohnehin.
    return -1;
  }
}

/** Reservierung auf die tatsaechlich gelesenen Seiten korrigieren. */
export async function liveBudgetKorrigieren(db, buchung, kosten) {
  if (!(buchung > 0)) return;
  try {
    await db.prepare("UPDATE live_budget SET kosten = ? WHERE id = ?").bind(kosten, buchung).run();
  } catch {
    /* die Reservierung bleibt dann eben stehen */
  }
}
