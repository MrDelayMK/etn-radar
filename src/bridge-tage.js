// Tagessummen aller Abfluesse aus der Bridge - die Grundlage, um den
// Bridge-Bestand bis zu ihrem Start im Maerz 2024 zurueckzurechnen.
//
// WARUM NICHT DIE TAGESBILANZ DES EXPLORERS: coin-balance-history-by-day
// reicht nur rund 90 Tage zurueck, und ihre Tagesgrenze stimmt nicht mit der
// der Zeitstempel ueberein (siehe Kopf von src/bridge-events.js). Die internen
// Transaktionen dagegen liest der Bridge-Durchgang ohnehin Seite fuer Seite -
// bisher wurde dabei nur alles unter 500.000 ETN verworfen. Die Tagessumme
// mitzuschreiben kostet damit keine einzige zusaetzliche Anfrage.
//
// DAS PROBLEM DER HAEPPCHEN: der Durchgang laeuft rueckwaerts in Haeppchen,
// und ein Tag kann genau auf einer Haeppchengrenze liegen - teils im einen,
// teils im naechsten, womoeglich erst im naechsten Lauf eine Woche spaeter.
// Darum:
//
//   - Ein Tag wird erst geschrieben, wenn er VOLLSTAENDIG gelesen ist, also
//     sobald ein aelterer Tag aufgetaucht ist.
//   - Der angefangene aelteste Tag wandert als Uebertrag zusammen mit dem
//     Cursor in bridge_scan und wird im naechsten Haeppchen fortgesetzt.
//   - Geschrieben wird UEBERSCHREIBEND, nie aufaddierend. Bricht ein Lauf
//     zwischen Tagessummen und Cursor ab, liest der naechste dasselbe
//     Haeppchen mit demselben Uebertrag noch einmal und kommt auf dieselben
//     Zahlen. Mit Aufaddieren waere genau dieser Tag doppelt gezaehlt.
//
// Betraege laufen als BigInt in Wei. Hunderttausende Einzelbetraege
// aufzusummieren ist genau der Fall, vor dem schema.sql warnt.

// Ab wann der Migrationschart den Bestand ZEIGT. Gesammelt wird die ganze
// Historie seit Maerz 2024, aber ueber zweieinhalb Jahre waeren die letzten
// Monate nur noch ein flacher Strich am rechten Rand.
export const HISTORIE_AB = "2026-01-01";

/** UTC-Tag eines Zeitstempels, "JJJJ-MM-TT". */
export const tagVon = (zeit) => String(zeit).slice(0, 10);

const leer = (day) => ({ day, abfluss_wei: 0n, abfluss_anzahl: 0, zufluss_wei: 0n });

/** Uebertrag fuer bridge_scan - BigInt kennt JSON nicht. */
export function uebertragText(u) {
  if (u == null) return null;
  return JSON.stringify({
    day: u.day,
    abfluss_wei: String(u.abfluss_wei),
    abfluss_anzahl: u.abfluss_anzahl,
    zufluss_wei: String(u.zufluss_wei),
  });
}

export function uebertragLesen(text) {
  if (!text) return null;
  try {
    const o = JSON.parse(text);
    return {
      day: o.day,
      abfluss_wei: BigInt(o.abfluss_wei),
      abfluss_anzahl: Number(o.abfluss_anzahl) || 0,
      zufluss_wei: BigInt(o.zufluss_wei),
    };
  } catch {
    return null;
  }
}

/**
 * Faltet ein Haeppchen in Tagessummen.
 *
 * @param {Array}  transfers  [{timestamp, from, to, value_wei}] - ein Stueck,
 *                            das lueckenlos an das vorige anschliesst
 * @param {string} bridge     Bridge-Adresse, klein geschrieben
 * @param {object} uebertrag  angefangener Tag aus dem vorigen Haeppchen, oder null
 * @param {boolean} ende      true, wenn danach nichts mehr kommt - dann ist auch
 *                            der aelteste Tag vollstaendig
 * @returns {{fertig: Array, uebertrag: object|null}}  fertig: neueste zuerst
 */
export function haeppchenFalten(transfers, bridge, uebertrag, ende) {
  const tage = new Map();
  if (uebertrag) tage.set(uebertrag.day, { ...uebertrag });
  for (const t of transfers) {
    const day = tagVon(t.timestamp);
    const e = tage.get(day) ?? leer(day);
    const wert = BigInt(t.value_wei);
    if (t.from === bridge) {
      e.abfluss_wei += wert;
      e.abfluss_anzahl++;
    } else if (t.to === bridge) {
      e.zufluss_wei += wert;
    }
    tage.set(day, e);
  }
  const sortiert = [...tage.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  if (ende || sortiert.length === 0) return { fertig: sortiert, uebertrag: null };
  return { fertig: sortiert.slice(0, -1), uebertrag: sortiert[sortiert.length - 1] };
}

/**
 * Die juengsten Tage neu auszaehlen - fuer den Blick nach oben.
 *
 * `abTag` ist der Tag, bis zu dessen Anfang zurueckgelesen wurde. Was davor
 * liegt, steht nur zufaellig mit auf der letzten Seite und bleibt unberuehrt.
 * Hat der Blick nach oben seinen Deckel erreicht, bevor er `abTag` erreichte
 * (`vollstaendig` false), ist sein aeltester Tag angebrochen und entfaellt.
 */
export function obenFalten(transfers, bridge, abTag, vollstaendig) {
  const drin = transfers.filter((t) => tagVon(t.timestamp) >= abTag);
  return haeppchenFalten(drin, bridge, null, vollstaendig).fertig;
}
