// Migration: Bridge-Verlauf, Bilanz zum Stichtag und die groessten Migrationen.

import { HISTORIE_AB } from "../bridge-tage.js";
import { tagVor } from "./grundlagen.js";

/**
 * Grosse Migrations-Tage: an welchen Tagen ist ungewoehnlich viel ETN aus der
 * Bridge geflossen, und an welche Wallets? Siehe src/bridge-events.js.
 */
// Ein Tag zaehlt nur, wenn an ihm mindestens EIN Transfer diese Groesse
// hatte. Dieselbe Zahl steht in src/bridge-events.js; hier wird sie beim Lesen
// noch einmal durchgesetzt.
//
// Warum doppelt: in der Datenbank koennen Zeilen aus einer aelteren Fassung
// des Laufs stehen, die noch aus der Tagesbilanz gerechnet hat. Solche Zeilen
// zeigen Tage mit siebenhundert Ueberweisungen zu je 50.000 ETN - also genau
// das, was dieses Panel nicht zeigen soll. Sie verschwinden damit sofort,
// statt erst beim naechsten woechentlichen Lauf.
const BRIDGE_MIN_TRANSFER_ETN = 500000;


export async function bridgeVerlauf(db, u) {
  // period=all: die ganze Migration seit dem Start der Bridge statt ab HISTORIE_AB.
  const alles = u?.searchParams.get("period") === "all";
  const stand = await db
    .prepare("SELECT fertig, cursor, aeltestes_bekannt, anker_wei, anker_zeit FROM bridge_scan WHERE id = 1")
    .first()
    .catch(() => null);
  // Weit genug zurueck ist auch ein Stand, der noch nicht als fertig markiert
  // wurde - etwa ein Lauf, der ueber HISTORIE_AB hinaus las und abgebrochen wurde.
  // Die ganze Historie dagegen erst, wenn wirklich nichts mehr aussteht.
  const weitGenug = alles
    ? stand?.fertig && !stand?.cursor
    : stand?.fertig || String(stand?.aeltestes_bekannt ?? "9999").slice(0, 10) < HISTORIE_AB;
  if (!weitGenug || !stand.anker_wei || !stand.anker_zeit) {
    return { vollstaendig: false, punkte: [] };
  }

  const ankerTag = String(stand.anker_zeit).slice(0, 10);
  const tage = (
    await db
      .prepare(
        "SELECT day, abfluss_wei, zufluss_wei FROM bridge_tage WHERE day >= ? AND day <= ?" +
          " ORDER BY day DESC"
      )
      .bind(alles ? "0000-00-00" : HISTORIE_AB, ankerTag)
      .all()
  ).results;

  const inEtn = (wei) => Number(wei / 10n ** 12n) / 1e6;
  let bestand = BigInt(stand.anker_wei);
  const punkte = [];
  if (tage[0]?.day !== ankerTag) punkte.push({ day: ankerTag, etn: inEtn(bestand) });
  for (const t of tage) {
    punkte.push({ day: t.day, etn: inEtn(bestand) });
    bestand += BigInt(t.abfluss_wei) - BigInt(t.zufluss_wei);
  }
  // Der Stand vor dem ersten gezeigten Tag - der Punkt, an dem der Verlauf
  // beginnt: der Jahreswechsel, bei der ganzen Historie der Tag vor dem Start.
  if (tage.length) {
    const start = alles ? tage[tage.length - 1].day : HISTORIE_AB;
    const vorher = new Date(Date.parse(start + "T00:00:00Z") - 86400000);
    punkte.push({ day: vorher.toISOString().slice(0, 10), etn: inEtn(bestand) });
  }
  punkte.reverse();
  return { vollstaendig: true, anker_zeit: stand.anker_zeit, punkte };
}

/* ---------- Bilanz zum Migrations-Stichtag -------------------------------
 *
 * Was die Migration am Ende gekostet hat: wie viel ETN nie herueberkam, was
 * das mit Umlaufmenge, Kurs und Marktkapitalisierung gemacht hat, und wer die
 * groessten Betraege noch rechtzeitig geholt hat.
 *
 * ABSICHTLICH SCHON VOR DEM STICHTAG SICHTBAR. Ein Bildschirm, der erst am
 * 31.01.2027 zum ersten Mal Daten bekommt, wird an genau diesem Tag zum
 * ersten Mal getestet - und das ist der eine Tag, an dem sich ein Fehler
 * nicht mehr reparieren laesst. Bis dahin steht in der "Nachher"-Spalte, was
 * ehrlich ist: noch nichts. Die "Vorher"-Seite arbeitet dagegen ab sofort mit
 * echten Zahlen.
 *
 * Die Vergleichspunkte kommen aus der Tabelle stichtag und werden am
 * jeweiligen Tag eingefroren (src/ingest.js, Abschnitt 7e). Nachtraeglich
 * liesse sich keiner davon rekonstruieren: der Bridge-Bestand laeuft weiter,
 * der Kurs erst recht.
 */
export async function bilanz(db, env) {
  const stichtag = String(env.MIGRATION_DEADLINE ?? "2027-01-31");
  const basis = Date.parse(stichtag + "T00:00:00Z");
  const jetzt = Date.now();
  // Der Stichtag selbst muss vorbei sein, nicht nur angebrochen - sonst
  // stuende dort ein halber Tag als Ergebnis.
  const vorbei = jetzt >= basis + 86400000;
  const tageBis = Math.round((basis - jetzt) / 86400000);

  const marker = (
    await db.prepare("SELECT schluessel, tag, daten FROM stichtag").all()
  ).results;
  const punkte = {};
  for (const m of marker) {
    try {
      punkte[m.schluessel] = { tag: m.tag, ...JSON.parse(m.daten) };
    } catch {
      /* eine kaputte Zeile darf nicht die ganze Seite kosten */
    }
  }

  // Der heutige Stand, im selben Format wie ein eingefrorener Marker. Solange
  // noch kein einziger gesetzt ist, ist er die gesamte "Vorher"-Seite; danach
  // bleibt er die Spalte "heute".
  const [snap, netz] = await Promise.all([
    db
      .prepare(
        "SELECT taken_at, day, total_supply, bridge_wei, etn_price, addr_count," +
          " total_addresses FROM snapshots WHERE status='ok' ORDER BY id DESC LIMIT 1"
      )
      .first(),
    db.prepare("SELECT * FROM network_daily ORDER BY day DESC LIMIT 1").first(),
  ]);

  let heute = null;
  if (snap) {
    const bridgeEtn = snap.bridge_wei
      ? Number(BigInt(snap.bridge_wei) / 10n ** 12n) / 1e6
      : null;
    const supply = Number(snap.total_supply ?? 0);
    const zirk = supply - (bridgeEtn ?? 0);
    heute = {
      tag: snap.day,
      bridge_etn: bridgeEtn,
      total_supply: supply,
      zirkulierend: zirk,
      preis: snap.etn_price,
      marktkapitalisierung: snap.etn_price != null ? zirk * snap.etn_price : null,
      holder_1m: netz?.holders_1m ?? null,
      holder_5m: netz?.holders_5m ?? null,
      holder_10m: netz?.holders_10m ?? null,
      top10_anteil: netz?.top10_share ?? null,
      top100_anteil: netz?.top100_share ?? null,
      adressen_gesamt: snap.total_addresses ?? null,
      adressen_erfasst: snap.addr_count ?? null,
    };
  }

  // Was nie herueberkam. Vor dem Stichtag ist das eine Hochrechnung aus dem
  // heutigen Bestand, danach der festgehaltene Wert - beides klar getrennt,
  // damit niemand eine Schaetzung fuer eine Tatsache haelt.
  const amStichtag = punkte.T0 ?? null;
  const grundlage = amStichtag ?? heute;
  const verloren = grundlage
    ? {
        etn: grundlage.bridge_etn,
        anteil_supply:
          grundlage.total_supply > 0 ? grundlage.bridge_etn / grundlage.total_supply : null,
        wert_usd:
          grundlage.preis != null && grundlage.bridge_etn != null
            ? grundlage.bridge_etn * grundlage.preis
            : null,
        endgueltig: !!amStichtag,
      }
    : null;

  // Endspurt: zieht die Migration kurz vor Schluss an? Aus dem Bridge-Verlauf,
  // ohne eine einzige zusaetzliche Anfrage. Die Reihe enthaelt nur Tage MIT
  // Aenderung, darum wird jeweils der aelteste vorhandene Wert im Fenster
  // gegen den juengsten gerechnet, nicht Zeile gegen Zeile.
  const bReihe = (
    await db
      .prepare(
        "SELECT day, etn FROM daily_balances WHERE address = ? AND day >= ?" +
          " ORDER BY day ASC"
      )
      .bind(String(env.BRIDGE_ADDRESS).toLowerCase(), tagVor(60))
      .all()
  ).results;
  const abfluss = (von, bis) => {
    const f = bReihe.filter((r) => r.day >= von && r.day <= bis);
    return f.length >= 2 ? f[0].etn - f[f.length - 1].etn : null;
  };
  const endspurt = {
    letzte_30: abfluss(tagVor(30), tagVor(0)),
    davor_30: abfluss(tagVor(60), tagVor(30)),
  };
  endspurt.faktor =
    endspurt.davor_30 > 0 && endspurt.letzte_30 != null
      ? endspurt.letzte_30 / endspurt.davor_30
      : null;

  // Wie weit die Transfer-Historie reicht. Die Liste der groessten
  // Migrationen selbst kommt aus /api/migrationen (siehe migrationen()).
  const stand = await db
    .prepare("SELECT aeltestes_bekannt, fertig, cursor IS NOT NULL AS hat_cursor FROM bridge_scan WHERE id = 1")
    .first()
    .catch(() => null);
  const aeltesterTag = stand?.aeltestes_bekannt?.slice(0, 10) ?? null;
  // Vollstaendig erst am Anfang der Bridge: fertig UND kein Cursor mehr.
  const transferVollstaendig = !!stand?.fertig && !stand?.hat_cursor;

  // Wallets, die es vor dem Stichtag noch nicht gab. Vorher ist die Liste
  // leer - die Abfrage kostet dank Index trotzdem nichts.
  const neueSeit = vorbei ? stichtag + "T00:00:00Z" : null;
  let neue = null;
  if (neueSeit) {
    neue = await db
      .prepare(
        "SELECT COUNT(*) anzahl, SUM(c.etn) etn FROM addresses a" +
          " JOIN current_balances c ON c.address = a.hash" +
          " WHERE a.first_seen >= ? AND a.hash != ?"
      )
      // Ohne die Bridge. Sie ist keine zugezogene Wallet, und ihr Bestand ist
      // groesser als der aller anderen zusammen - im Probelauf machte sie aus
      // der Summe das Doppelte des tatsaechlichen Werts.
      .bind(neueSeit, String(env.BRIDGE_ADDRESS).toLowerCase())
      .first();
  }

  return {
    stichtag,
    vorbei,
    tage_bis: vorbei ? null : Math.max(0, tageBis),
    tage_seit: vorbei ? Math.round((jetzt - basis) / 86400000) : null,
    punkte,
    heute,
    verloren,
    endspurt,
    neue_wallets: neue,
    // Wie weit die Transfer-Historie reicht. Solange der Durchgang nicht am
    // Anfang der Bridge ist, sind "Top 10" die Top 10 des bisher gepruefen
    // Fensters - und das gehoert dazugeschrieben, sonst liest sich eine
    // Teilmenge wie eine Bestenliste.
    transfers_ab: aeltesterTag,
    transfers_vollstaendig: transferVollstaendig,
    mindestbetrag: BRIDGE_MIN_TRANSFER_ETN,
  };
}

/* ---------- Groesste Migrationen aus der Bridge ---------------------------
 *
 * Je Wallet und Tag zusammengefasst: wer an einem Tag in drei Teilen migriert,
 * hat einmal migriert. Am 16.04.2024 stand sonst dieselbe Wallet mit 428 Mio.
 * in drei Transfers dreimal in den Top 10. Die Zahl der Teile geht mit.
 *
 * Die zusammengefasste Liste entsteht in EINER Abfrage ueber alle knapp 2.000
 * grossen Transfers und liegt dann eine halbe Stunde im Zwischenspeicher. Jahr
 * und Seite schneiden nur noch daraus - sonst kostete jede neue Kombination
 * aus Jahr und Seite wieder den ganzen Tabellenlauf.
 */
const MIGRATIONEN_TTL = 1800;

async function migrationenAlle(db) {
  const intern = new Request("https://intern.etn-radar/migrationen");
  const treffer = await caches.default.match(intern);
  if (treffer) return treffer.json();
  const zeilen = (
    await db
      .prepare(
        "SELECT day, to_address, SUM(etn) AS etn, COUNT(*) AS teile FROM bridge_transfers" +
          " GROUP BY to_address, day ORDER BY etn DESC"
      )
      .all()
  ).results.map((r) => [r.day, r.to_address, r.etn, r.teile]);
  await caches.default.put(
    intern,
    new Response(JSON.stringify(zeilen), {
      headers: { "content-type": "application/json", "cache-control": "max-age=" + MIGRATIONEN_TTL },
    })
  );
  return zeilen;
}

export async function migrationen(db, u) {
  const alle = await migrationenAlle(db);
  const periode = u.searchParams.get("period") ?? "";
  const liste = /^\d{4}$/.test(periode) ? alle.filter((r) => r[0].startsWith(periode)) : alle;
  const offset = Math.max(0, Math.min(liste.length, Math.floor(Number(u.searchParams.get("offset")) || 0)));
  const limit = Math.max(1, Math.min(50, Math.floor(Number(u.searchParams.get("limit")) || 25)));
  const seite = liste.slice(offset, offset + limit);

  // Label und heutiger Bestand - in EINER Abfrage, nicht je Zeile eine.
  const adressen = [...new Set(seite.map((r) => r[1]))];
  const info = {};
  if (adressen.length) {
    const zeilen = (
      await db
        .prepare(
          "SELECT a.hash, a.label, a.label_type, a.checksum_hash, c.etn" +
            " FROM addresses a LEFT JOIN current_balances c ON c.address = a.hash" +
            " WHERE a.hash IN (" + adressen.map(() => "?").join(",") + ")"
        )
        .bind(...adressen)
        .all()
    ).results;
    for (const z of zeilen) info[z.hash] = z;
  }

  return {
    jahre: [...new Set(alle.map((r) => r[0].slice(0, 4)))].sort(),
    gesamt: liste.length,
    offset,
    mindestbetrag: BRIDGE_MIN_TRANSFER_ETN,
    eintraege: seite.map(([tag, adr, etn, teile]) => ({
      address: adr,
      checksum_hash: info[adr]?.checksum_hash ?? null,
      label: info[adr]?.label ?? null,
      label_type: info[adr]?.label_type ?? null,
      bestand_jetzt: info[adr]?.etn ?? null,
      tag,
      etn,
      teile,
    })),
  };
}
