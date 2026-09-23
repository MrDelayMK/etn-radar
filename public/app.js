// ---------- Formatting ----------
const LOC = "en-US";
const nf = (n, d = 0) =>
  n == null || !isFinite(n) ? "—"
  : new Intl.NumberFormat(LOC, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

/** Shorten large ETN amounts so they stay readable. */
function kurz(n, plus) {
  if (n == null || !isFinite(n)) return "—";
  const s = n < 0 ? "-" : plus ? "+" : "";
  const a = Math.abs(n);
  if (a >= 1e9) return s + nf(a / 1e9, 2) + "B";
  if (a >= 1e6) return s + nf(a / 1e6, 2) + "M";
  if (a >= 1e3) return s + nf(a / 1e3, 1) + "K";
  return s + nf(a, 0);
}
const pct = (n) => (n == null || !isFinite(n) ? "—" : (n > 0 ? "+" : "") + nf(n, 2) + "%");

/**
 * Percentages become meaningless when the starting balance was near zero
 * (e.g. +47,619,047,619,047% for a freshly funded wallet). Say "new" instead.
 */
function pctSafe(p, vorher) {
  if (p == null || !isFinite(p)) return "—";
  if (vorher != null && vorher < 1) return "new";
  if (Math.abs(p) >= 100000) return "new";
  return pct(p);
}
// Die gekuerzte Adresse landet an sieben Stellen direkt im HTML, teils in
// einem href. Sie stammt zwar aus der Kette und ist praktisch immer sauberes
// Hex - aber "praktisch immer" ist bei etwas, das ungeprueft ins Markup geht,
// kein Argument. Einmal hier abgesichert statt siebenmal an der Verwendung.
const kurzAdr = (a) => (a ? esc(a.slice(0, 8) + "…" + a.slice(-6)) : "—");
const EXPLORER = "https://blockexplorer.electroneum.com/address/";

const PERIODEN = [
  { k: "24h", t: "24H" }, { k: "7d", t: "7D" }, { k: "30d", t: "30D" },
  { k: "90d", t: "90D" }, { k: "6m", t: "6M" },
];

function ruheText(t) {
  if (t == null) return "—";
  if (t < 1) return "today";
  if (t === 1) return "yesterday";
  if (t < 60) return t + " days";
  if (t < 730) return nf(t / 30.4, 0) + " mo";
  return nf(t / 365, 1) + " yr";
}
function zeitHer(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return Math.round(s / 60) + " min";
  if (s < 86400) return Math.round(s / 3600) + " h";
  return Math.round(s / 86400) + " d";
}
const el = (id) => document.getElementById(id);

// Der Header-Chip ("snapshot X ago") wurde bisher nur beim Laden von Overview
// gesetzt - ein Refresh auf der Activity-Seite konnte dadurch neuere Daten
// zeigen als der Header, obwohl beide vom selben Snapshot stammen sollten.
// Jetzt zentral: jede Stelle, die einen snapshot-Zeitstempel bekommt, ruft
// das hier auf, und nur der jeweils NEUESTE bekannte Stand gewinnt.
let letzterBekannterSnapshot = null;
/* ---------- Frische der Daten ---------------------------------------------
 *
 * Der Snapshot laeuft alle 30 Minuten. Bleibt er aus - das Schreibkontingent
 * der Datenbank gerissen, der Explorer nicht erreichbar, ein fehlgeschlagener
 * Lauf -, zeigt die Seite weiter Zahlen, die aussehen wie immer. Genau das ist
 * einmal neun Stunden lang passiert, und sichtbar war es nur an einem kleinen
 * "snapshot 6 h ago" in der Kopfzeile.
 *
 * Drei Stufen, gemessen am Abstand zum letzten Snapshot:
 *
 *   bis 90 Minuten    alles normal (drei Laeufe Spielraum - ein einzelner
 *                     verpasster Lauf ist kein Ereignis)
 *   bis 6 Stunden     Kopfzeile faerbt sich, die Zahl steht dort ohnehin
 *   darueber          zusaetzlich ein Hinweis oben auf der Seite, weil die
 *                     Zahlen dann nicht mehr als aktuell durchgehen
 */
const FRISCH_WARNEN_MIN = 90;
const FRISCH_ALARM_MIN = 360;

function pruefeFrische() {
  if (!letzterBekannterSnapshot) return;
  const minuten = (Date.now() - Date.parse(letzterBekannterSnapshot)) / 60000;
  const chip = el("snapTime").closest(".chip");
  const warn = el("staleWarn");

  chip.classList.toggle("alt", minuten >= FRISCH_WARNEN_MIN && minuten < FRISCH_ALARM_MIN);
  chip.classList.toggle("tot", minuten >= FRISCH_ALARM_MIN);

  if (minuten < FRISCH_ALARM_MIN) {
    warn.hidden = true;
    return;
  }
  el("staleText").innerHTML =
    "<b>These numbers are " + zeitHer(letzterBekannterSnapshot) + " old.</b> " +
    "The snapshot normally runs every 30 minutes and has not come through since " +
    new Date(letzterBekannterSnapshot).toLocaleString(LOC, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    }) + ". Balances, ranks and events on this page are from then, not from now.";
  warn.hidden = false;
}

function setSnapTime(iso) {
  if (!iso) return;
  if (!letzterBekannterSnapshot || Date.parse(iso) > Date.parse(letzterBekannterSnapshot)) {
    letzterBekannterSnapshot = iso;
  }
  el("snapTime").textContent = "snapshot " + zeitHer(letzterBekannterSnapshot) + " ago";
  pruefeFrische();
}
const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

/**
 * Betreiber-Token fuer die "Run now"-Knoepfe.
 *
 * Die loesen GitHub-Actions-Laeufe aus - auf einer oeffentlichen Seite darf
 * das nicht jeder. Einmal mit ?admin=TOKEN aufrufen, danach liegt es lokal im
 * Browser und die Knoepfe erscheinen. Fuer alle anderen sind sie unsichtbar.
 * Ohne gesetztes ADMIN_TOKEN im Worker bleibt alles offen wie bisher.
 */
const ADMIN = {
  token: (() => {
    const u = new URL(location.href);
    const ausUrl = u.searchParams.get("admin");
    if (ausUrl) {
      try { localStorage.setItem("etnAdminToken", ausUrl); } catch { /* privater Modus */ }
      u.searchParams.delete("admin"); // nicht in der Adresszeile stehen lassen
      history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
      return ausUrl;
    }
    try { return localStorage.getItem("etnAdminToken"); } catch { return null; }
  })(),
};
const adminKopf = () => (ADMIN.token ? { "X-Admin-Token": ADMIN.token } : {});

// Unfertige Bereiche (Cluster-Vermutungen) sind oeffentlich ausgeblendet, bis
// sie geprueft sind. Mit ?labs=1 werden sie sichtbar - so laesst sich auf der
// echten Seite mit echten Daten testen, ohne dass Besucher etwas Halbfertiges
// zu sehen bekommen. Die Merkung bleibt im Browser.
(() => {
  const u = new URL(location.href);
  if (u.searchParams.has("labs")) {
    const an = u.searchParams.get("labs") !== "0";
    try { an ? localStorage.setItem("etnLabs", "1") : localStorage.removeItem("etnLabs"); } catch {}
    u.searchParams.delete("labs");
    history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
  }
  let an = false;
  try { an = localStorage.getItem("etnLabs") === "1"; } catch {}
  if (an) document.querySelectorAll(".labs").forEach((e) => e.removeAttribute("hidden"));
})();

/* ---------- Abrufe und der Browserspeicher --------------------------------
 *
 * Gemessen am 09.09.2026 auf der Live-Seite: /api/overview und /api/bilanz
 * kamen mit transferSize 0 zurueck - also gar nicht aus dem Netz, sondern aus
 * dem Speicher des Browsers, und das auch beim frischen Seitenaufruf.
 *
 * Die Ursache liegt nicht im Worker: der schickt "max-age=60". Cloudflare
 * ueberschreibt das fuer alles, was es selbst zwischenspeichert, auf die
 * Browser-Vorgabe der Zone - hier vier Stunden. Wer die Seite einmal besucht
 * hatte, sah danach bis zu vier Stunden dieselben Zahlen, egal wie oft der
 * Snapshot inzwischen gelaufen war. Der 20-Sekunden-Takt bemerkte den neuen
 * Snapshot zwar, holte danach aber wieder nur die alte Antwort aus dem
 * Browserspeicher - die Selbstaktualisierung lief ins Leere.
 *
 * Loesung: die Snapshot-Nummer haengt an der URL. Sie ist genau dann neu, wenn
 * es neue Daten gibt, und dann ist es fuer den Browser eine andere Adresse,
 * die er holen MUSS.
 *
 * Warum kein Zeitstempel: alle Besucher teilen sich dieselbe Nummer und damit
 * dieselbe URL. Der Zwischenspeicher des Workers greift weiter, und die
 * Datenbank wird sogar seltener gefragt als bisher - einmal je Snapshot statt
 * einmal je Minute.
 */
let SNAPSHOT_MARKE = null;
let markeLaeuft = null;
let bekannteSnapshotId = null;

// Diese Antworten haengen nicht am Snapshot und muessen immer frisch sein:
// der Snapshot-Stand selbst, sonst merkte niemand je eine Aenderung, die
// Betreiber-Ansichten, die sich jederzeit aendern koennen, und die
// Job-Zustaende, die ein Knopfdruck sofort veraendert.
const OHNE_MARKE = [
  "/api/stand", "/api/feedback", "/api/besuche",
  "/api/census/", "/api/clusters/", "/api/exchanges/", "/api/bridge/",
  // Der Bridge-Verlauf haengt bewusst DOCH an der Nummer. Ohne sie hielt der
  // Cache nach dem Durchgang vom 10.09.2026 noch sechs Stunden lang die alte
  // Antwort "unvollstaendig" fest. Alle 30 Minuten neu gerechnet kostet er
  // rund 250 gelesene Zeilen - dafuer ist er nach jedem Lauf sofort aktuell.
];

/** Die Snapshot-Nummer, einmal geholt und danach aus dem Gedaechtnis. */
function markeBereit() {
  return (markeLaeuft ??= (async () => {
    try {
      const st = await hole("/api/stand");
      if (st?.snapshot_id != null) {
        SNAPSHOT_MARKE = st.snapshot_id;
        bekannteSnapshotId ??= st.snapshot_id;
      }
    } catch {
      /* ohne Nummer laedt die Seite wie bisher - schlimmstenfalls aelter */
    }
  })());
}

async function hole(pfad, bust) {
  // Jeder snapshot-gebundene Abruf wartet selbst auf die Nummer. Sich auf die
  // Reihenfolge der Aufrufe zu verlassen ging schief: die Statusabfragen und
  // die Uebersicht starten am Modulanfang, also bevor sie feststuende.
  if (!bust && SNAPSHOT_MARKE == null && !OHNE_MARKE.some((x) => pfad.startsWith(x))) {
    await markeBereit();
  }
  // bust=true haengt einen Cache-Buster an: der manuelle Refresh-Knopf soll
  // wirklich neu laden, nicht aus dem Zwischenspeicher.
  let url = pfad;
  if (bust) {
    url = pfad + (pfad.includes("?") ? "&" : "?") + "_=" + Date.now();
  } else if (SNAPSHOT_MARKE != null && !OHNE_MARKE.some((x) => pfad.startsWith(x))) {
    url = pfad + (pfad.includes("?") ? "&" : "?") + "s=" + SNAPSHOT_MARKE;
  }
  const r = await fetch(url, { headers: adminKopf() });
  if (r.status === 429) {
    // Das Minutenbudget fuer Explorer-Abrufe ist aufgebraucht - kein Fehler,
    // sondern ein "gleich nochmal".
    const e = new Error("The explorer is busy right now - try again in a minute.");
    e.beschaeftigt = true;
    throw e;
  }
  if (!r.ok) throw new Error(pfad + " → HTTP " + r.status);
  return r.json();
}
const fehlerText = (e) => (e.beschaeftigt ? e.message : "Error: " + e.message);

function periodTabs(host, aktiv, onChange, liste = PERIODEN) {
  host.innerHTML = liste.map((p) =>
    '<button class="ghost' + (p.k === aktiv ? " on" : "") + '" data-p="' + p.k + '">' + p.t + "</button>"
  ).join("");
  host.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    [...host.children].forEach((x) => x.classList.toggle("on", x === b));
    onChange(b.dataset.p);
  };
}

// ---------- Chart ----------
//
// Die SVG-Koordinaten entsprechen exakt den Bildschirmpixeln: viewBox wird auf
// die gemessene Containerbreite gesetzt statt auf einen festen Wert. Sonst
// skaliert der Browser die Grafik - und mit ihr die Schrift, weshalb die
// Achsenbeschriftung vorher auf ~6px zusammengeschrumpft und unlesbar war.
// Als Nebeneffekt braucht die Maus-Zuordnung keine Umrechnung mehr.

/* ---------- Migrationstempo ----------------------------------------------
 *
 * Wie viel ETN hat die Bridge je Woche tatsaechlich verlassen.
 *
 * VORGESCHICHTE, damit sie nicht noch einmal gemacht wird: Hier stand zuerst
 * ein Chart, der bis zum Stichtag reichte und drei Linien zeigte - den
 * tatsaechlichen Verlauf, die Fortschreibung im heutigen Tempo und den Weg,
 * der noetig waere. Von diesen drei Linien enthielt genau eine Messwerte. Die
 * anderen beiden waren mit dem Lineal gezogen: eine Gerade zum Stichtag und
 * eine Gerade zur Null. Sie sahen nach Erkenntnis aus und waren Arithmetik -
 * und die eine Aussage, die daraus folgte, stand als Zahl ohnehin zweimal auf
 * derselben Seite ("409K/Tag" gegen "57,6M/Tag noetig").
 *
 * Diese Ansicht besteht dagegen ausschliesslich aus Gemessenem und
 * beantwortet die Frage, die keine Kachel beantwortet: wird die Migration
 * schneller oder langsamer? Der Bestand allein zeigt das nicht - er faellt
 * so oder so, nur unterschiedlich steil.
 *
 * Bewusst OHNE eine Linie fuer das noetige Tempo: die laege beim
 * Sechzigfachen des hoechsten Balkens, und alles Gemessene waere wieder ein
 * unsichtbarer Strich am unteren Rand. Derselbe Fehler, nur umgedreht.
 */
function tempoReihe(punkte, takt) {
  // daily_balances traegt nur Tage MIT Aenderung. Eine Luecke heisst also
  // "keine Bewegung", nicht "keine Daten" - der Abfluss wird darum dem Tag
  // zugeschlagen, an dem er gemessen wurde, und die Tage davor bleiben null.
  if (!punkte.length) return [];
  const monatlich = takt === "monat";
  const beginn = (tag) => {
    const d = new Date(tag + "T00:00:00Z");
    if (monatlich) d.setUTCDate(1);
    else d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Montag
    return d;
  };

  const eimer = new Map();
  for (let i = 1; i < punkte.length; i++) {
    const raus = punkte[i - 1].etn - punkte[i].etn;
    if (!(raus > 0)) continue;
    const k = beginn(punkte[i].day).toISOString().slice(0, 10);
    eimer.set(k, (eimer.get(k) ?? 0) + raus);
  }

  // Zeitraeume ganz ohne Bewegung fehlen in der Map und muessen ergaenzt
  // werden - sonst verschwaende eine Null-Woche aus dem Bild, und genau die
  // ist eine Aussage.
  const ende = Date.parse(punkte[punkte.length - 1].day + "T00:00:00Z");
  const reihe = [];
  for (const d = beginn(punkte[0].day); d.getTime() <= ende; ) {
    reihe.push({ ab: d.toISOString().slice(0, 10), etn: eimer.get(d.toISOString().slice(0, 10)) ?? 0 });
    if (monatlich) d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCDate(d.getUTCDate() + 7);
  }

  // Der erste Eimer ist fast immer angeschnitten - die Historie beginnt
  // mitten in ihm - und saehe darum kuenstlich schwach aus. Beim letzten ist
  // das genauso, er wird aber gebraucht: er ist der aktuelle Stand. Also
  // bleibt er drin und wird im Tooltip als laufend gekennzeichnet.
  const angeschnitten = Date.parse(punkte[0].day) > Date.parse(reihe[0]?.ab ?? punkte[0].day);
  return angeschnitten && reihe.length > 2 ? reihe.slice(1) : reihe;
}

function zeichneTempoChart(svg, punkte, opts) {
  if (punkte) svg._tp = punkte;
  if (opts) svg._to = opts;
  const o = svg._to ?? {};
  const holder = svg.parentElement;
  const tip = holder.querySelector(".tip");
  if (holder.clientWidth === 0) return;

  const takt = o.takt ?? "woche";
  // Mit der ganzen Historie waeren es ueber 130 Wochen - Balken von wenigen
  // Pixeln Breite. Die Woche zeigt darum das letzte Jahr, der Monat alles.
  const reihe = tempoReihe(svg._tp ?? [], takt).slice(takt === "woche" ? -52 : 0);
  const W = Math.max(320, Math.round(holder.clientWidth));
  const H = W < 640 ? 260 : 330;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.style.height = H + "px";

  if (reihe.length < 2) {
    svg.innerHTML = '<text x="' + W / 2 + '" y="' + H / 2 + '" fill="#5b6b83" font-size="14" ' +
      'text-anchor="middle">not enough history yet</text>';
    return;
  }

  const PT = 18, PB = 34, PL = 88, PR = 14;
  const hi = Math.max(...reihe.map((r) => r.etn)) * 1.12 || 1;
  const breite = (W - PL - PR) / reihe.length;
  const X = (i) => PL + i * breite;
  const Y = (v) => H - PB - (v / hi) * (H - PT - PB);

  const linien = [0, .25, .5, .75, 1].map((f) => {
    const y = PT + f * (H - PT - PB);
    return '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y +
      '" stroke="#1e293b" stroke-width="1"/>' +
      '<text x="' + (PL - 10) + '" y="' + (y + 4) + '" fill="#7d8ba3" font-size="12.5" ' +
      'text-anchor="end" font-family="ui-monospace,monospace">' + kurz(hi - f * hi) + "</text>";
  }).join("");

  const schritt = Math.max(1, Math.ceil(reihe.length / Math.max(2, Math.floor((W - PL - PR) / 92))));
  const datumTexte = reihe.map((r, i) =>
    i % schritt ? "" :
      '<text x="' + (X(i) + breite / 2) + '" y="' + (H - 11) + '" fill="#7d8ba3" font-size="12" ' +
      'text-anchor="middle" font-family="ui-monospace,monospace">' +
      new Date(r.ab).toLocaleDateString(LOC,
        takt === "monat" ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" }) +
      "</text>"
  ).join("");

  const balken = reihe.map((r, i) => {
    const y = Y(r.etn);
    const h = r.etn > 0 ? Math.max(2, H - PB - y) : 0;
    return '<rect data-b="' + i + '" x="' + (X(i) + breite * 0.14).toFixed(1) +
      '" y="' + (H - PB - h).toFixed(1) +
      '" width="' + (breite * 0.72).toFixed(1) + '" height="' + h.toFixed(1) +
      '" rx="2.5" fill="#fbbf24" opacity=".85"/>';
  }).join("");

  svg.innerHTML = linien + datumTexte + balken;

  // Der zuletzt hervorgehobene Balken. Ohne diesen Zustand muesste bei jeder
  // Mausbewegung die ganze Reihe zurueckgesetzt werden.
  let hell = null;
  const hervorheben = (i) => {
    if (hell === i) return;
    if (hell != null) svg.querySelector('[data-b="' + hell + '"]')?.setAttribute("opacity", ".85");
    hell = i;
    if (hell != null) svg.querySelector('[data-b="' + hell + '"]')?.setAttribute("opacity", "1");
  };

  holder.onmousemove = (e) => {
    const r = holder.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    // Am aeussersten rechten Rand ergaebe die Division genau reihe.length -
    // ein Index, den es nicht gibt. Vorher blinkte der Hinweis dort weg.
    const i = Math.min(reihe.length - 1, Math.floor((x - PL) / breite));
    if (x < PL || i < 0) { tip.classList.remove("on"); hervorheben(null); return; }
    hervorheben(i);

    const w = reihe[i];
    const ab = new Date(w.ab + "T00:00:00Z");
    const naechster = new Date(ab);
    if (takt === "monat") naechster.setUTCMonth(ab.getUTCMonth() + 1);
    else naechster.setUTCDate(ab.getUTCDate() + 7);
    // Der letzte Eimer laeuft noch. Statt eines angehaengten Hinweises endet
    // der Zeitraum dann einfach auf "today" - kuerzer und zugleich deutlicher.
    const letzterTag = Date.parse((o.letzterTag ?? w.ab) + "T00:00:00Z");
    const laeuft = naechster.getTime() - 86400000 > letzterTag;
    const bisZeit = Math.min(naechster.getTime() - 86400000, letzterTag);
    const tage = Math.max(1, Math.round((bisZeit - ab.getTime()) / 86400000) + 1);
    const kurzDatum = (d) => d.toLocaleDateString(LOC, { month: "short", day: "numeric" });
    tip.innerHTML = "<b>" + kurz(w.etn) + " ETN</b><span>" +
      kurzDatum(ab) + " - " + (laeuft ? "today" : kurzDatum(new Date(bisZeit))) +
      " · " + kurz(w.etn / tage) + "/day</span>";
    tip.style.right = "auto";
    tip.classList.add("on");

    // Senkrecht an den Balken heften statt oben in der Ecke kleben: so ist
    // sichtbar, wozu die Zahl gehoert. Passt sie ueber dem Balken nicht mehr
    // hin, rutscht sie hinein statt aus dem Bild.
    const b = tip.getBoundingClientRect();
    const yBalken = Y(w.etn);
    tip.style.top =
      Math.max(2, Math.min(H - PB - b.height - 6, yBalken - b.height - 9)) + "px";

    // Waagrecht mittig ueber dem Balken. Am Rand wuerde ein Festklemmen an der
    // Kante den Hinweis vom Balken loesen - er kippt darum auf die andere
    // Seite, so wie er es auch bei einem Menue tut.
    const px = (X(i) + breite / 2) / W * r.width;
    let links = px - b.width / 2;
    if (links < 0) links = Math.min(px + 10, r.width - b.width);
    else if (links + b.width > r.width) links = Math.max(0, px - b.width - 10);
    tip.style.left = links + "px";
  };
  holder.onmouseleave = () => { tip.classList.remove("on"); hervorheben(null); };
}

function zeichneChart(svg, punkte, totalSupply) {
  // Zustand haengt am SVG-Element, NICHT an einer gemeinsamen Variable:
  // dieselbe Funktion zeichnet den Bridge-Verlauf (Overview) und den
  // Wallet-Verlauf (Investigate). Mit einem gemeinsamen Zustand landete beim
  // Zurueckwechseln zur Overview die zuletzt angesehene Wallet-Historie im
  // Bridge-Chart - also schlicht falsche Daten.
  if (punkte) svg._punkte = punkte;
  if (totalSupply != null) svg._totalSupply = totalSupply;
  const daten = svg._punkte;
  const holder = svg.parentElement;
  const tip = holder.querySelector(".tip");
  // Auf einem versteckten Reiter ist die Breite 0. Dann NICHT zeichnen: sonst
  // brennt sich die Mindestbreite (320) in das viewBox ein und der Chart
  // bleibt beim Zurueckwechseln winzig. Der ResizeObserver zeichnet neu,
  // sobald das Element wieder eine echte Breite hat.
  if (holder.clientWidth === 0) return;
  const W = Math.max(320, Math.round(holder.clientWidth));
  const H = W < 640 ? 240 : 320;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.style.height = H + "px";

  if (!daten || daten.length < 2) {
    svg.innerHTML = '<text x="' + W / 2 + '" y="' + H / 2 + '" fill="#5b6b83" font-size="14" ' +
      'text-anchor="middle">not enough history yet</text>';
    return;
  }

  const PT = 18, PB = 34, PL = svg._totalSupply ? 104 : 74, PR = 14;
  // Wallet-Chart im Dollar-Modus: dieselbe Kurve, Werte in USD, gruen statt gold.
  const usd = !!svg._usd;
  const farbe = usd ? "#34d399" : "#fbbf24";
  const verlaufId = usd ? "grUsd" : "gr";
  const ys = daten.map((p) => p.etn);
  const min = Math.min(...ys), max = Math.max(...ys);
  const spanne = max - min || Math.abs(max) * 0.02 || 1;
  // Nie unter null: ein Bestand oder Wert kann nicht negativ werden.
  const lo = min >= 0 ? Math.max(0, min - spanne * 0.12) : min - spanne * 0.12;
  // Mehr als die gesamte Menge kann nie in der Bridge liegen - sonst stuende
  // bei der ganzen Historie "106 %" an der obersten Linie.
  const hi = svg._totalSupply
    ? Math.min(max + spanne * 0.12, Math.max(max, svg._totalSupply))
    : max + spanne * 0.12;

  const X = (i) => PL + (i / (daten.length - 1)) * (W - PL - PR);
  const Y = (v) => H - PB - ((v - lo) / (hi - lo)) * (H - PT - PB);

  let d = "";
  daten.forEach((p, i) => { d += (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.etn).toFixed(1); });
  const flaeche = d + "L" + X(daten.length - 1) + " " + (H - PB) + "L" + PL + " " + (H - PB) + "Z";

  // Werteachse links, ausserhalb der Zeichenflaeche - dadurch ueberlagert die
  // Beschriftung die Kurve nicht mehr.
  const linien = [0, .25, .5, .75, 1].map((f) => {
    const y = PT + f * (H - PT - PB);
    const wert = hi - f * (hi - lo);
    const pctLbl = svg._totalSupply ? " (" + nf(wert / svg._totalSupply * 100, 1) + "%)" : "";
    return '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y +
      '" stroke="#1e293b" stroke-width="1"/>' +
      '<text x="' + (PL - 10) + '" y="' + (y + 4) + '" fill="#7d8ba3" font-size="12.5" ' +
      'text-anchor="end" font-family="ui-monospace,monospace">' + (usd ? "$" : "") + kurz(wert) + pctLbl + "</text>";
  }).join("");

  // Datumsachse: so viele Marken, wie bei der aktuellen Breite lesbar sind.
  // Ueber mehr als ein Jahr hinweg sagt der Monat samt Jahr mehr als der Tag.
  const ueberJahr =
    Date.parse(daten[daten.length - 1].day) - Date.parse(daten[0].day) > 330 * 86400000;
  const marken = Math.max(2, Math.min(6, Math.floor((W - PL - PR) / 130)));
  const datumTexte = Array.from({ length: marken + 1 }, (_, n) => {
    const i = Math.round((n / marken) * (daten.length - 1));
    const anker = n === 0 ? "start" : n === marken ? "end" : "middle";
    return '<text x="' + X(i) + '" y="' + (H - 11) + '" fill="#7d8ba3" font-size="12.5" ' +
      'text-anchor="' + anker + '" font-family="ui-monospace,monospace">' +
      new Date(daten[i].day).toLocaleDateString(LOC,
        ueberJahr ? { month: "short", year: "numeric" } : { month: "short", day: "numeric" }) + "</text>";
  }).join("");

  svg.innerHTML =
    '<defs><linearGradient id="' + verlaufId + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="' + farbe + '" stop-opacity=".3"/>' +
    '<stop offset="100%" stop-color="' + farbe + '" stop-opacity="0"/></linearGradient></defs>' +
    linien + datumTexte +
    '<path d="' + flaeche + '" fill="url(#' + verlaufId + ')"/>' +
    '<path d="' + d + '" fill="none" stroke="' + farbe + '" stroke-width="2.4" ' +
    'stroke-linejoin="round" stroke-linecap="round"/>' +
    '<g id="cross" style="display:none">' +
    '<line y1="' + PT + '" y2="' + (H - PB) + '" stroke="' + farbe + '" stroke-width="1" ' +
    'stroke-dasharray="4 4" opacity=".7"/>' +
    '<circle r="6" fill="' + farbe + '" stroke="#0b111e" stroke-width="2.5"/></g>' +
    '<circle cx="' + X(daten.length - 1) + '" cy="' + Y(ys[ys.length - 1]) + '" r="4.5" fill="' + farbe + '"/>';

  const cross = svg.querySelector("#cross");
  const linie = cross.querySelector("line");
  const punkt = cross.querySelector("circle");

  function zeige(ev) {
    const r = holder.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const i = Math.max(0, Math.min(daten.length - 1,
      Math.round(((x - PL) / (W - PL - PR)) * (daten.length - 1))));
    const p = daten[i];

    cross.style.display = "";
    linie.setAttribute("x1", X(i)); linie.setAttribute("x2", X(i));
    punkt.setAttribute("cx", X(i)); punkt.setAttribute("cy", Y(p.etn));

    const datum = "<span>" + new Date(p.day).toLocaleDateString(LOC,
      { year: "numeric", month: "short", day: "numeric" }) + "</span>";
    tip.innerHTML = usd
      ? '<b class="num">' + dollar(p.etn) + "</b>" + datum +
        '<span class="num">' + kurz(p.menge) + " ETN × " + wiPreis(p.preis) + "</span>"
      : '<b class="num">' + nf(p.etn, 0) + " " + (svg._einheit ?? "ETN") + "</b>" + datum +
      (i > 0 && p.etn !== daten[i - 1].etn
        ? '<span class="num ' + (p.etn - daten[i - 1].etn < 0 ? "down" : "up") + '">' +
          kurz(p.etn - daten[i - 1].etn, true) + " vs. previous point</span>"
        : "");
    tip.classList.add("on");
    const links = X(i) > W * 0.6;
    tip.style.left = links ? "auto" : X(i) + 14 + "px";
    tip.style.right = links ? W - X(i) + 14 + "px" : "auto";
  }
  const verstecke = () => { cross.style.display = "none"; tip.classList.remove("on"); };
  holder.onmousemove = zeige;
  holder.onmouseleave = verstecke;
  holder.ontouchmove = (e) => { if (e.touches[0]) zeige(e.touches[0]); };
  holder.ontouchend = verstecke;
}

// Wallets je schneller Stufe ueber die Zeit - eine kleine Karte je Stufe statt
// einer gemeinsamen Grafik. 26 Humpbacks und 915 Octopus auf einer Achse waeren
// eine Linie am Boden und eine oben, und sechs Stufenfarben in einem Chart sind
// nicht auseinanderzuhalten (Farbpruefung 11.09.2026: Violett/Blau bei
// Farbschwaeche kaum, die beiden Gruentoene selbst bei normalem Sehen kaum).
//
// Ersetzt "Concentration over time": den Anteil der Top 10/100/1000 an der
// zirkulierenden Menge hat kaum jemand verstanden.
const TIER_VERLAUF = { tage: null, tiers: null };
const TIER_VERLAUF_STUFEN = ["humpback", "whale", "shark", "dolphin", "fish", "octopus"];

async function ladeTierVerlauf() {
  try {
    TIER_VERLAUF.tage = (await hole("/api/tier-verlauf")).tage ?? [];
  } catch {
    TIER_VERLAUF.tage = [];
  }
  zeichneTierVerlauf();
}

function zeichneTierVerlauf() {
  const box = el("tierVerlauf");
  if (!box || !TIER_VERLAUF.tage || !TIER_VERLAUF.tiers) return;
  if (box.clientWidth === 0) return; // versteckter Reiter, siehe zeichneChart

  // Der letzte Punkt ist der Stand von JETZT, wie in den Tier-Zeilen darueber -
  // sonst stuende unten eine andere Zahl als oben.
  const heute = new Date().toISOString().slice(0, 10);
  const jetzt = Object.fromEntries(TIER_VERLAUF.tiers.map((t) => [t.key, t.anzahl]));
  const tage = TIER_VERLAUF.tage.filter((t) => t.day < heute).concat([{ day: heute, ...jetzt }]);
  const datum = (tag) =>
    new Date(tag + "T00:00:00Z").toLocaleDateString(LOC, { month: "short", day: "numeric", timeZone: "UTC" });
  el("tierVerlaufRange").textContent = tage.length > 1 ? "since " + datum(tage[0].day) : "";

  box.innerHTML = TIER_VERLAUF_STUFEN.map((key) => {
    const t = TIER_VERLAUF.tiers.find((x) => x.key === key);
    if (!t) return "";
    const reihe = tage.filter((p) => p[key] != null);
    const erst = reihe[0]?.[key];
    const letzt = reihe[reihe.length - 1]?.[key];
    const diff = reihe.length > 1 ? letzt - erst : null;
    const prozent = diff && erst > 0 ? Math.abs(diff / erst) * 100 : null;
    const diffText = diff == null ? ""
      : (diff > 0 ? "+" : diff < 0 ? "−" : "±") + nf(Math.abs(diff)) +
        (prozent != null ? " (" + (diff > 0 ? "+" : "−") + nf(prozent, prozent < 10 ? 1 : 0) + "%)" : "");
    const klasse = diff > 0 ? "up" : diff < 0 ? "down" : "";
    return '<div class="tvkarte" data-tier="' + key + '">' +
      '<div class="kopf"><span class="nm">' + t.emoji + " " + esc(t.name) + "</span>" +
      '<span class="wert num">' + nf(letzt) + "</span></div>" +
      '<div class="unter"><span class="' + klasse + '">' + diffText + "</span><span>wallets</span></div>" +
      '<div class="chartholder"><svg></svg><div class="tip"></div></div></div>';
  }).join("");

  box.querySelectorAll(".tvkarte").forEach((karte) => {
    const key = karte.dataset.tier;
    tierMiniChart(
      karte.querySelector(".chartholder"),
      tage.filter((p) => p[key] != null).map((p) => ({ day: p.day, n: p[key] })),
      TIERFARBEN[key] ?? "#5b9cff",
      datum
    );
  });
}

// opts: format (Achse), einheit (Tooltip), links (Platz fuer die Achse),
// ende: "datum" beschriftet den letzten Punkt mit seinem Tag statt "now".
function tierMiniChart(holder, reihe, farbe, datum, opts = {}) {
  const zahl = opts.format ?? nf;
  const amEnde = (i) => (opts.ende === "datum" ? datum(reihe[i].day) : "now");
  const svg = holder.querySelector("svg");
  const tip = holder.querySelector(".tip");
  const W = Math.max(200, Math.round(holder.clientWidth));
  const H = 92;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  if (reihe.length < 2) {
    svg.innerHTML = '<text x="' + W / 2 + '" y="' + H / 2 + '" fill="#5b6b83" font-size="12" ' +
      'text-anchor="middle">not enough history yet</text>';
    return;
  }

  const PT = 8, PB = 18, PL = opts.links ?? 38, PR = 8;
  const werte = reihe.map((p) => p.n);
  const min = Math.min(...werte), max = Math.max(...werte);
  // Mindestspanne: sonst liefe aus 912 -> 915 eine Linie quer ueber die ganze
  // Karte, und ein Plus von 0,3 % saehe aus wie ein Ausbruch.
  const spanne = Math.max(max - min, 4, max * 0.08);
  const lo = Math.max(0, Math.floor((max + min) / 2 - spanne / 2));
  const hi = Math.ceil(lo + spanne);
  const letzte = reihe.length - 1;
  const X = (i) => PL + (i / letzte) * (W - PL - PR);
  const Y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const achse = (v) =>
    '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) +
    '" stroke="#1e293b" stroke-width="1"/>' +
    '<text x="' + (PL - 6) + '" y="' + (Y(v) + 3.5).toFixed(1) + '" fill="#7d8ba3" font-size="10.5" ' +
    'text-anchor="end" font-family="ui-monospace,monospace">' + zahl(v) + "</text>";

  let linie = "";
  reihe.forEach((p, i) => { linie += (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.n).toFixed(1); });
  const flaeche = linie + "L" + X(letzte).toFixed(1) + " " + (H - PB) + "L" + PL + " " + (H - PB) + "Z";

  svg.innerHTML = achse(hi) + achse(lo) +
    '<text x="' + PL + '" y="' + (H - 4) + '" fill="#7d8ba3" font-size="10.5" ' +
      'font-family="ui-monospace,monospace">' + datum(reihe[0].day) + "</text>" +
    '<text x="' + (W - PR) + '" y="' + (H - 4) + '" fill="#7d8ba3" font-size="10.5" text-anchor="end" ' +
      'font-family="ui-monospace,monospace">' + amEnde(letzte) + "</text>" +
    '<path d="' + flaeche + '" fill="' + farbe + '" opacity=".1"/>' +
    '<path d="' + linie + '" fill="none" stroke="' + farbe + '" stroke-width="2" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>' +
    '<line class="kreuz" y1="' + PT + '" y2="' + (H - PB) + '" stroke="#7d8ba3" stroke-width="1" opacity="0"/>' +
    '<circle class="punkt" r="4" fill="' + farbe + '" stroke="#0a0f1b" stroke-width="2" cx="' +
      X(letzte).toFixed(1) + '" cy="' + Y(reihe[letzte].n).toFixed(1) + '"/>';

  const kreuz = svg.querySelector(".kreuz");
  const punkt = svg.querySelector(".punkt");
  const setzePunkt = (i) => {
    punkt.setAttribute("cx", X(i).toFixed(1));
    punkt.setAttribute("cy", Y(reihe[i].n).toFixed(1));
  };
  const zeige = (ev) => {
    const r = holder.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(letzte, Math.round(((x - PL) / (W - PL - PR)) * letzte)));
    kreuz.setAttribute("x1", X(i));
    kreuz.setAttribute("x2", X(i));
    kreuz.setAttribute("opacity", ".7");
    setzePunkt(i);
    // Werte zuerst, Datum darunter - und per textContent, nicht als HTML.
    const wert = document.createElement("b");
    wert.textContent = nf(reihe[i].n) + " " + (opts.einheit ?? "wallets");
    const wann = document.createElement("span");
    wann.textContent = i === letzte ? amEnde(i) : datum(reihe[i].day);
    tip.replaceChildren(wert, wann);
    tip.classList.add("on");
    const px = (X(i) / W) * r.width;
    const rechts = px > r.width / 2;
    tip.style.left = rechts ? "auto" : px + 10 + "px";
    tip.style.right = rechts ? r.width - px + 10 + "px" : "auto";
  };
  const verstecke = () => {
    kreuz.setAttribute("opacity", "0");
    tip.classList.remove("on");
    setzePunkt(letzte);
  };
  holder.onmousemove = zeige;
  holder.onmouseleave = verstecke;
  holder.ontouchmove = (e) => { if (e.touches[0]) zeige(e.touches[0]); };
  holder.ontouchend = verstecke;
}

// Pixelgenaues Zeichnen heisst: bei Groessenaenderung neu zeichnen.
//
// Zusaetzlich zum ResizeObserver ein Nachzieher auf visibilitychange/resize:
// ein Chart, der bei Breite 0 uebersprungen wurde (verstecktes Fenster,
// minimierter Tab), bekommt sonst unter Umstaenden nie eine zweite Chance -
// der Observer feuert in dem Zustand nicht zuverlaessig.
/**
 * Welche Sicht der Migrationschart gerade zeigt.
 *
 * "deadline" ist die Vorgabe, weil sie die eigentliche Frage beantwortet:
 * schafft die Migration den Termin? "detail" ist die alte, gezoomte Ansicht -
 * sie zeigt die Bewegung der letzten Monate, die in der Gesamtsicht
 * zwangslaeufig zur waagrechten Linie wird.
 */
// Vorgabe ist der Bestand: die Ansicht, die eine Frage ohne Vorwissen
// beantwortet ("wie viel liegt noch drin"). Das Tempo ist die Nachfrage
// darauf und steht einen Klick daneben.
const MIG = { sicht: "bestand", bereich: "2026", punkte: [], opts: null, voll: {} };
// Woche oder Monat. Die Woche zeigt einzelne grosse Migrationstage noch als
// eigenen Balken; der Monat glaettet sie weg und zeigt dafuer den Trend.
// Beides ist berechtigt, je nach Frage - darum beides.
const MIG_TAKTE = { tempo_woche: "woche", tempo_monat: "monat" };

function zeichneMigration() {
  const svg = el("bridgeChart");
  if (!MIG.punkte.length) return;
  // Beide Ansichten teilen sich dasselbe SVG. Der jeweils andere Zustand
  // haengt am Element und wuerde sonst beim Umschalten mitgezeichnet.
  svg.onmousemove = null;
  const tip = el("chartTip");
  tip.classList.remove("on");
  // Auch "right": der Bestands-Chart setzt es, der Balken-Chart nicht. Blieb es
  // stehen, war der Hinweis in Per week/Per month zwischen links und rechts
  // eingespannt - zu breit und bei jeder Mausbewegung springend.
  tip.style.top = "";
  tip.style.left = "";
  tip.style.right = "";
  const takt = MIG_TAKTE[MIG.sicht];
  if (takt) {
    el("migTitel").textContent =
      "Leaving the bridge, per " + (takt === "monat" ? "month" : "week");
    zeichneTempoChart(svg, MIG.punkte, {
      ...MIG.opts,
      takt,
      letzterTag: MIG.punkte[MIG.punkte.length - 1]?.day,
    });
  } else {
    el("migTitel").textContent = "Still to migrate";
    zeichneChart(svg, MIG.punkte, MIG.opts?.totalSupply);
  }
}

const MIG_SICHTEN = [
  ["bestand", "Amount left"],
  ["tempo_woche", "Per week"],
  ["tempo_monat", "Per month"],
];
// Ab 2026 oder die ganze Migration seit Maerz 2024. Erst sichtbar, wenn der
// Verlauf aus dem Bridge-Durchgang da ist - vorher gaebe es nichts umzuschalten.
const MIG_BEREICHE = [
  ["2026", "2026"],
  ["all", "All"],
];
function migSchalter() {
  const box = el("migViews");
  const knopf = (art, k, t, an) =>
    "<button data-" + art + '="' + k + '" class="ghost' + (an ? " on" : "") + '">' + t + "</button>";
  box.innerHTML =
    (MIG.voll["2026"]
      ? MIG_BEREICHE.map(([k, t]) => knopf("b", k, t, MIG.bereich === k)).join("") +
        '<i class="tabsep"></i>'
      : "") +
    MIG_SICHTEN.map(([k, t]) => knopf("s", k, t, MIG.sicht === k)).join("");
  box.querySelectorAll("button[data-s]").forEach((b) => {
    b.onclick = () => {
      MIG.sicht = b.dataset.s;
      migSchalter();
      zeichneMigration();
    };
  });
  box.querySelectorAll("button[data-b]").forEach((b) => {
    b.onclick = () => {
      if (MIG.bereich === b.dataset.b) return;
      MIG.bereich = b.dataset.b;
      ladeBridgeVerlauf();
    };
  });
}

function alleChartsNachziehen() {
  if (el("prChart")._punkte) zeichnePreisChart();
  if (MIG.punkte.length) zeichneMigration();
  if (el("invChart")?._punkte) zeichneChart(el("invChart"));
  if (TIER_VERLAUF.tage) zeichneTierVerlauf();
  if (VIS.daten) zeichneBesucherChart();
  if (FLOW.punkte) zeichneFlowChart(el("flowChart"));
}
function beobachte(holderId, zeichnen) {
  let timer;
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(zeichnen, 120);
  }).observe(el(holderId));
}
beobachte("prHolder", () => { if (el("prChart")._punkte) zeichnePreisChart(); });
beobachte("tierVerlauf", () => { if (TIER_VERLAUF.tage) zeichneTierVerlauf(); });
beobachte("visHolder", () => { if (VIS.daten) zeichneBesucherChart(); });
beobachte("chartHolder", () => { if (MIG.punkte.length) zeichneMigration(); });
// #invChart fehlt, solange ein Wallet ohne genug Verlauf offen ist: dann steht
// statt des Diagramms nur der Hinweis im Holder (renderWalletDetail).
beobachte("invChartHolder", () => { if (el("invChart")?._punkte) zeichneChart(el("invChart")); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) alleChartsNachziehen(); });
window.addEventListener("resize", alleChartsNachziehen);

// ---------- Overview ----------
async function ladeOverview() {
  const d = await hole("/api/overview");
  if (d.leer) {
    el("bridgeEtn").textContent = "no data";
    return;
  }
  setSnapTime(d.snapshot.taken_at);
  setzePreis(d.preis, false);
  TELEGRAM_BOT = d.telegram_bot || null;
  spendeEinblenden(d.spenden_adresse);

  el("bridgeEtn").innerHTML = kurz(d.bridge_etn) +
    ' <span style="font-size:.4em;color:var(--tx2);font-weight:500">ETN</span>';
  el("bridgeSub").innerHTML =
    "<b>" + nf(d.bridge_anteil * 100, 1) + "%</b> of all ETN has not made the move yet";

  const m = d.migration;
  el("deadlinePill").textContent = "Deadline " +
    new Date(m.deadline).toLocaleDateString(LOC, { day: "2-digit", month: "short", year: "numeric" });
  el("perDay").textContent = kurz(m.abfluss_pro_tag);
  el("daysLeft").textContent = m.tage_bis_deadline ?? "—";
  el("circ").textContent = kurz(d.zirkulierend);
  // Das noetige Tempo gehoert direkt neben das tatsaechliche: nebeneinander
  // braucht der Vergleich keine Erklaerung.
  const noetigProTag = m.tage_bis_deadline ? d.bridge_etn / m.tage_bis_deadline : null;
  el("perDayNeeded").textContent = noetigProTag != null ? kurz(noetigProTag) : "—";
  el("perDayNeeded").className =
    "v num " + (noetigProTag != null && noetigProTag > (m.abfluss_pro_tag || 0) ? "down" : "up");

  const v = d.bridge_verlauf ?? [];
  // Die ganze Historie hat Vorrang, sobald sie einmal geladen ist - sonst
  // schluege der Chart bei jedem neuen Snapshot auf die 120 Tage zurueck.
  MIG.punkte = MIG.voll[MIG.bereich] ?? MIG.voll["2026"] ?? v;
  MIG.opts = {
    deadline: m.deadline,
    totalSupply: d.total_supply,
    proTag: m.abfluss_pro_tag ?? 0,
  };
  migSchalter();
  zeichneMigration();
  migVerlaufBeschriften();

  const migrPct = d.bridge_anteil != null ? Math.max(0, Math.min(100, (1 - d.bridge_anteil) * 100)) : 0;
  el("migDone").style.width = migrPct.toFixed(1) + "%";
  el("migDoneLbl").textContent = nf(migrPct, 1) + "%";
  el("migRestLbl").textContent = d.bridge_anteil != null ? nf(d.bridge_anteil * 100, 1) + "%" : "—";

  zeichneBurnKarte(d, m);

  el("k10m").textContent = nf(d.holder.ueber_10m);
  el("k10ms").textContent = nf(d.holder.ueber_5m) + " ≥ 5M · " + nf(d.holder.ueber_1m) + " ≥ 1M";
  const s = d.schlaefer ?? {};
  el("kSleep").textContent = nf(s.anzahl);
  el("kSleepS").textContent = kurz(s.etn) + " ETN locked up";
  el("kConc").textContent = d.holder.top100_anteil != null ? nf(d.holder.top100_anteil * 100, 1) + "%" : "—";
  el("kConcS").textContent = d.holder.top10_anteil != null
    ? "top 10 hold " + nf(d.holder.top10_anteil * 100, 1) + "%" : "—";
  // Top N live plus die Wallets aus dem woechentlichen Census - so viele stehen im Leaderboard.
  const woche = d.census_wallets ?? 0;
  el("kAddr").textContent = nf(d.snapshot.addr_count + woche);
  el("kAddrS").textContent = woche
    ? nf(d.snapshot.addr_count) + " live · " + nf(woche) + " weekly"
    : "in the latest snapshot";

  // Stand von jetzt als letzter Punkt der Tier-Verlaeufe.
  TIER_VERLAUF.tiers = d.tiers;
  zeichneTierVerlauf();

  zeichneTiers(d.tiers, d.zirkulierend, d.tier_info);
}

/**
 * Die Burn-Karte: was passiert mit dem, was bis zur Deadline nicht migriert ist.
 *
 * Der eigentliche Punkt ist nicht die Restmenge, sondern das Tempo-Verhaeltnis:
 * "aktuell X/Tag, noetig waeren Y/Tag". Erst daran sieht man, ob die Frist
 * ueberhaupt erreichbar ist - und der Faktor dazwischen ist die Aussage.
 */
function zeichneBurnKarte(d, m) {
  const rest = m.rest_bei_deadline;
  const tage = m.tage_bis_deadline;
  const deadline = new Date(m.deadline).toLocaleDateString(LOC, { day: "2-digit", month: "long", year: "numeric" });
  el("burnDeadline").textContent = "Deadline " + deadline;

  if (rest == null || !tage) {
    el("burnEtn").textContent = "—";
    el("burnSub").textContent = "The forecast appears once a few days of bridge history exist.";
    return;
  }

  // Welches Tempo waere noetig, um bis zur Deadline alles herueberzuholen?
  const noetig = d.bridge_etn / tage;
  const faktor = noetig / (m.abfluss_pro_tag || 1);
  const anteil = m.anteil_bei_deadline * 100;

  el("burnEtn").innerHTML = kurz(rest) +
    ' <span style="font-size:.42em;font-weight:600;color:var(--tx2)">ETN would miss the deadline</span>';
  el("burnSub").innerHTML =
    "At today's pace that's what is still waiting on " + deadline + " - <b>" +
    nf(anteil, 1) + "%</b> of every ETN in existence, held by people who never made the move.";

  // Balken: geretteter Anteil vs. verbrennender Anteil, gemessen an der
  // Menge, die HEUTE noch in der Bridge liegt.
  const gerettet = Math.max(0, Math.min(100, (1 - rest / d.bridge_etn) * 100));
  el("burnBarDone").style.width = gerettet.toFixed(1) + "%";

  const urteil = el("burnVerdict");
  if (faktor <= 1) {
    urteil.textContent = "🎉 At this pace everything makes it across in time.";
    urteil.style.color = "var(--acc2)";
  } else {
    // Bewusst nur der Faktor: er ist nachrechenbar (noetiges Tempo geteilt
    // durch aktuelles) und braucht keine ausgedachte Zusatzgroesse daneben.
    urteil.innerHTML = "🔥 Migration would have to run <b>" + nf(faktor, 1) +
      "× faster</b> than today for all of it to make it across.";
    urteil.style.color = faktor > 3 ? "var(--down)" : "var(--warn)";
  }
}

/**
 * Netzwerk-Kennzahlen. Kommen als einzige nicht aus der eigenen Datenbank,
 * sondern live vom Explorer (siehe network() in src/index.js). Faellt der
 * Abruf aus, bleibt die Karte auf ihren Strichen stehen - sie ist Beiwerk,
 * kein Grund, die Uebersicht scheitern zu lassen.
 */
async function ladeNetzwerk() {
  let d;
  try {
    d = await hole("/api/network");
  } catch {
    return;
  }
  if (!d || d.leer) return;

  el("netBlocks").textContent = nf(d.blockhoehe);
  el("netBlockTime").textContent = d.blockzeit_ms
    ? "~" + nf(d.blockzeit_ms / 1000, 1) + " s per block"
    : "—";
  el("netTx").textContent = kurz(d.transaktionen);
  el("netAddr").textContent = kurz(d.adressen);
  el("netUtil").textContent = d.auslastung != null ? nf(d.auslastung, 1) + "%" : "—";
  el("netGas").textContent = d.gaspreis != null ? nf(d.gaspreis, 2) : "—";
  el("netCap").textContent = d.marktkapitalisierung != null
    ? "$" + kurz(d.marktkapitalisierung) : "—";

  el("netTxToday").textContent = kurz(d.tx_heute);
  // Bewusst KEIN Prozentvergleich gegen den Tagesschnitt: der laufende Tag ist
  // noch nicht vorbei, morgens um sechs staende dort zwangslaeufig -80%, und
  // das saehe nach einem Einbruch aus statt nach einer halben Uhrzeit. Beide
  // Zahlen nebeneinander, den Vergleich zieht der Leser selbst.
  el("netTxAvg").textContent = d.tx_schnitt
    ? "30-day average " + kurz(d.tx_schnitt) : "";

  zeichneNetzChart(d.tx_verlauf ?? []);
  fuellePreiskarte(d);
}

// Der Kurs steht an zwei Stellen: in der Kopfzeile und gross auf der
// Preiskarte. Die Kopfzeile bekam ihn bisher aus dem letzten Snapshot, die
// Karte direkt vom Explorer - bei einem Snapshot von vor sechs Stunden standen
// dort sichtbar zwei verschiedene Zahlen. Der Live-Wert gewinnt, und der
// Snapshot-Wert ueberschreibt ihn danach nicht mehr: beide Lader laufen
// nebeneinander, die Reihenfolge ist nicht zugesichert.
let preisIstLive = false;
let PREIS_JETZT = null;
function setzePreis(preis, live) {
  if (preis == null) return;
  if (preisIstLive && !live) return;
  if (live) preisIstLive = true;
  PREIS_JETZT = preis;
  el("price").textContent = "$" + nf(preis, 6);
}

const PREISKARTE = { preis: null, cap: null };

/** Die Preiskarte: aktueller Kurs, Veraenderung ueber den Zeitraum, Spanne. */
function fuellePreiskarte(d) {
  setzePreis(d.preis, true);
  PREISKARTE.preis = d.preis ?? null;
  PREISKARTE.cap = d.marktkapitalisierung ?? null;
  el("prBig").textContent = d.preis != null ? "$" + d.preis.toFixed(6) : "—";
  el("prCap").textContent = d.marktkapitalisierung != null
    ? "$" + kurz(d.marktkapitalisierung) : "—";
}

/* ---------- ETN-Kursverlauf ----------------------------------------------
 *
 * Kurze Zeitraeume kommen aus den eigenen Snapshots (halbstuendlich), lange
 * aus der Tagesreihe - siehe preisverlauf() in src/index.js. "All" waechst
 * von selbst, sobald die eigene Historie ueber die 30 Tage des Explorers
 * hinausreicht.
 */
const KURS_PERIODEN = [
  { k: "24h", t: "24H" },
  { k: "7d", t: "7D" },
  { k: "30d", t: "30D" },
  { k: "90d", t: "90D" },
  { k: "1y", t: "1Y" },
];
const KURS = { zeitraum: "30d", punkte: [], feinkoernig: false };

async function ladeKurs(p) {
  if (p) KURS.zeitraum = p;
  el("prTabs").innerHTML = KURS_PERIODEN.map(
    (x) => '<button class="ghost' + (x.k === KURS.zeitraum ? " on" : "") +
      '" data-kurs="' + x.k + '">' + x.t + "</button>"
  ).join("");

  let d;
  try {
    d = await hole("/api/price?period=" + KURS.zeitraum);
  } catch {
    return;
  }
  KURS.punkte = d.punkte ?? [];
  KURS.feinkoernig = !!d.feinkoernig;
  zeichneMarken(d.marken);

  const v = KURS.punkte;
  const c = el("prChg");
  if (v.length >= 2) {
    const pct = ((v[v.length - 1].preis - v[0].preis) / v[0].preis) * 100;
    c.textContent = (pct >= 0 ? "+" : "") + nf(pct, 1) + "%";
    c.className = "num " + (pct >= 0 ? "up" : "down");
    el("prHigh").textContent = "$" + Math.max(...v.map((x) => x.preis)).toFixed(6);
    el("prLow").textContent = "$" + Math.min(...v.map((x) => x.preis)).toFixed(6);
    // Nicht den gewaehlten Zeitraum behaupten, sondern den tatsaechlich
    // abgedeckten nennen. Die eigene Historie beginnt erst mit dem ersten
    // Snapshot - "over 30 days" ueber einer Kurve aus zwei Tagen waere falsch.
    el("prChgLbl").textContent = zeitraumText(v);
  } else {
    c.textContent = "—";
    c.className = "num dim3";
    el("prChgLbl").textContent = v.length ? "only one data point yet" : "no data yet";
    el("prHigh").textContent = el("prLow").textContent = "—";
  }

  zeichnePreisChart(v);
}

/** Wie lang der abgedeckte Zeitraum wirklich ist, in Worten. */
function zeitraumText(v) {
  const ms = Date.parse(v[v.length - 1].zeit) - Date.parse(v[0].zeit);
  const stunden = ms / 3600000;
  if (stunden < 48) return "over " + Math.round(stunden) + " hours";
  return "over " + Math.round(stunden / 24) + " days";
}

/*
 * Den Kurs teilen: drei Fassungen zum selben Stand - laut, ruhig und als
 * Rechnung. Keine negative Fassung und keine Prognose: die Zahlen sind, was
 * sie sind. Geteilt wird immer der Zeitraum, den die Karte gerade zeigt.
 *
 * Eigene Hashtags ueber die eigene Blase hinaus (Boersen, Krypto allgemein) -
 * sie ERSETZEN die festen, sonst sprengt der laengere Text die 280 Zeichen,
 * die ohne X Premium gelten.
 */
const PREIS_TAGS = "#ETN #Electroneum #Crypto #Bitcoin #KuCoin #HTX";

// Die Marktkapitalisierungen liegen im What-if-Reiter; fuer den Kurs-Post
// reicht ein bekannter Coin als Massstab. Faellt der Abruf aus, bleibt die Zeile weg.
let preisVergleichLaeuft = null;
const preisVergleich = () =>
  (preisVergleichLaeuft ??= (WI.daten ? Promise.resolve(WI.daten) : hole("/api/whatif"))
    .catch(() => { preisVergleichLaeuft = null; return null; }));

function preisTexte(zusatz) {
  const p = PREISKARTE.preis ?? PREIS_JETZT;
  const v = KURS.punkte;
  if (!(p > 0) || v.length < 2) return null;
  const pct = ((v[v.length - 1].preis - v[0].preis) / v[0].preis) * 100;
  const spanne = zeitraumText(v).replace("over ", "in ");
  // Der aktuelle Kurs zaehlt mit: er kommt aus dem letzten Snapshot und kann
  // juenger sein als der letzte Punkt der Kurve - sonst stuende "high" unter dem Preis.
  const hoch = Math.max(...v.map((x) => x.preis), p);
  const tief = Math.min(...v.map((x) => x.preis), p);
  const cap = PREISKARTE.cap ? wiCap(PREISKARTE.cap) : null;
  const menge = PREISKARTE.cap && p ? PREISKARTE.cap / p : null;
  const rang = zusatz?.etn?.rang ? "#" + zusatz.etn.rang + " on CoinGecko" : null;
  // Ein bekannter Coin als Massstab - was ein ETN bei dessen Groesse kostete.
  const coin = (zusatz?.coins ?? []).find((c) => c.i === "dogecoin")
    ?? (zusatz?.coins ?? []).find((c) => c.r >= 20 && c.r <= 60);
  const zeilen = (...z) => z.filter((x) => x != null).join("\n");

  // Geredet wird wie ein Mensch, gerechnet wird ehrlich. Feuer statt Rakete:
  // laut ja, aber kein Kursversprechen. Steht der Kurs nicht im Plus, erzaehlt
  // die laute Fassung von der Chain statt vom Chart - behauptet wird nichts.
  const steigt = pct >= 1;
  // Aufbau jedes Posts: Haken, kurze Zahlenzeilen zum Ueberfliegen, zwei
  // Saetze Stimme, Schlusszeile. Ein Block Fliesstext liest im Feed niemand.
  const schluss = "Watch it live on ETN Radar \ud83d\udc47";
  const zahlenBlock = zeilen(
    "\ud83d\udcb0 " + wiPreis(p) + " per ETN",
    (pct >= 0 ? "\ud83d\udcc8 +" : "\ud83d\udcc9 -") + nf(Math.abs(pct), 1) + "% " + spanne,
    "\ud83d\udd3b Low " + wiPreis(tief) + "  \u00b7  \ud83d\udd3a High " + wiPreis(hoch),
    [cap ? "\ud83c\udff7\ufe0f Market cap " + cap : null, rang].filter(Boolean).join("  \u00b7  ") || null
  );

  return [
    ["hype", zeilen(
      steigt ? "\ud83d\udd25 Electroneum is on the move again." : "\ud83d\udc40 ETN is having one of its quiet spells.",
      "",
      zahlenBlock,
      "",
      steigt
        ? "The chart is not being subtle about it. Everyone who called this coin boring has gone remarkably quiet."
        : "The chart is more of a slow breath than a sprint right now. The numbers stay out in the open either way.",
      "",
      schluss), "price-hype"],
    // Nachdenklich statt ruhig: Blick nach vorn, aber ohne Prognose - der
    // Stichtag der Migration ist ein Fakt, alles andere bleibt offen.
    ["denk", zeilen(
      "\ud83e\udd14 Where does ETN go over the next few weeks?",
      "",
      zahlenBlock,
      "",
      "Meanwhile the clock keeps running towards January 2027, when the last legacy ETN has to be across the bridge.",
      "Nobody knows where the price goes from here - the next few weeks should be interesting.",
      "",
      schluss), "price-next"],
    ["napkin", zeilen(
      "\ud83e\uddee Napkin math on ETN.",
      "",
      zeilen(
        "\ud83d\udcb0 " + wiPreis(p) + " per ETN",
        cap ? "\ud83c\udff7\ufe0f Market cap " + cap : null,
        menge ? "\ud83c\udfaf At $0.01 per ETN \u2192 " + wiCap(menge * 0.01) + " market cap" : null,
        coin && menge
          ? (coin.i === "dogecoin" ? "\ud83d\udc15" : "\ud83e\ude99") + " At " + coin.n + "'s market cap \u2192 " +
            wiPreis(coin.c / menge) + " per ETN"
          : null
      ),
      "",
      "Not a prediction, just a division anyone can do on a napkin.",
      "",
      schluss), "price-napkin"],
  ];
}

el("prShare").addEventListener("click", async () => {
  // Der Vergleichscoin darf den Dialog nicht aufhalten - ohne ihn eine Zeile weniger.
  const varianten = preisTexte(await preisVergleich());
  if (!varianten) return;
  shareTextOeffnen({
    titel: "\ud83d\udce2 Share the ETN price",
    varianten,
    tags: PREIS_TAGS,
    url: location.origin + "/",
  });
});

el("prTabs").onclick = (e) => {
  const b = e.target.closest("button[data-kurs]");
  if (b) ladeKurs(b.dataset.kurs);
};



/**
 * ETN-Preis der letzten 30 Tage.
 *
 * Die Werte kommen ueber /api/network vom Explorer - dort aus der
 * Marktkapitalisierung geteilt durch die Umlaufmenge, weil das Kursfeld der
 * Reihe nur fuer den jeweils neuesten Tag gefuellt ist (siehe network() in
 * src/index.js).
 */
/** Achsenbeschriftung: Uhrzeit bei kurzen Zeitraeumen, Datum bei langen. */
function achsenText(zeit) {
  const d = new Date(zeit);
  return KURS.feinkoernig
    ? d.toLocaleTimeString(LOC, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(LOC, { month: "short", day: "numeric" });
}

/** Beschriftung im Fadenkreuz - dort darf es ausfuehrlicher sein. */
function punktText(zeit) {
  const d = new Date(zeit);
  return KURS.feinkoernig
    ? d.toLocaleString(LOC, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(LOC, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Allzeithoch, das Hoch von 2021 und das Allzeittief - jeweils mit dem
 * Abstand zum heutigen Kurs.
 *
 * Die Prozentzahl ist der Punkt der ganzen Sache: "$0.2079" sagt fuer sich
 * genommen wenig, "−99,5 % davon entfernt" sagt alles.
 */
const MARKEN_TEXT = {
  ath: "All-time high",
  hoch_2021: "2021 peak",
  hoch_12m: "12-month high",
  atl: "All-time low",
  tief_12m: "12-month low",
};
// Reihenfolge von oben nach unten, nicht die der Datenbank.
const MARKEN_FOLGE = ["ath", "hoch_2021", "hoch_12m", "atl"];

function zeichneMarken(marken) {
  const host = el("prMarken");
  if (!host) return;
  if (!marken?.length) {
    host.innerHTML = "";
    return;
  }
  const nach = Object.fromEntries(marken.map((m) => [m.schluessel, m]));
  host.innerHTML = MARKEN_FOLGE.filter((k) => nach[k])
    .map((k) => {
      const m = nach[k];
      const pct = m.abstand_pct;
      // Minus heisst: Wir liegen darunter. Bei einem Tief ist das Plus davor
      // die gute Nachricht, bei einem Hoch das Minus die schlechte - die
      // Farbe folgt dem Vorzeichen, nicht der Bedeutung.
      const klasse = pct == null ? "" : pct >= 0 ? "up" : "down";
      const txt =
        pct == null ? "—" : (pct >= 0 ? "+" : "") + nf(pct, pct > -100 && pct < 1000 ? 1 : 0) + "%";
      return '<div class="marke ' + klasse + '"><span class="k">' +
        (MARKEN_TEXT[k] ?? k) + "</span>" +
        '<span class="pct">' + txt + "</span>" +
        '<span class="u"><span class="w">$' + preisText(m.preis) + "</span>" +
        "<span>" + (m.tag ? datumKurz(m.tag) : "") + "</span></span></div>";
    })
    .join("");
}

/** Kleine Kurse brauchen mehr Nachkommastellen als grosse. */
function preisText(v) {
  if (v == null) return "—";
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(5);
  return v.toFixed(6);
}

function datumKurz(tag) {
  const d = new Date(tag + "T00:00:00Z");
  return isNaN(d) ? tag : d.toLocaleDateString(LOC, { year: "numeric", month: "short", day: "numeric" });
}

function zeichnePreisChart(punkte) {
  const svg = el("prChart");
  if (punkte) svg._punkte = punkte;
  const daten = svg._punkte ?? [];
  const holder = el("prHolder");
  if (holder.clientWidth === 0) return; // versteckter Reiter
  const W = Math.max(320, Math.round(holder.clientWidth));
  const H = W < 640 ? 190 : 240;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.style.height = H + "px";

  if (daten.length < 2) {
    svg.innerHTML = '<text x="' + W / 2 + '" y="' + H / 2 + '" fill="#5b6b83" font-size="14" ' +
      'text-anchor="middle">no price history available</text>';
    return;
  }

  const PT = 16, PB = 30, PL = 66, PR = 12;
  const werte = daten.map((p) => p.preis);
  const min = Math.min(...werte), max = Math.max(...werte);
  const spanne = max - min || max * 0.02;
  const lo = min - spanne * 0.18, hi = max + spanne * 0.18;

  const X = (i) => PL + (i / (daten.length - 1)) * (W - PL - PR);
  const Y = (v) => H - PB - ((v - lo) / (hi - lo || 1)) * (H - PT - PB);

  // Steigt der Kurs ueber den Zeitraum, gruen - sonst rot. Die Farbe traegt
  // dieselbe Aussage wie die Prozentzahl daneben und muss zu ihr passen.
  const rauf = daten[daten.length - 1].preis >= daten[0].preis;
  const farbe = rauf ? "#22d3a7" : "#f4635e";

  const raster = [0, .25, .5, .75, 1].map((f) => {
    const y = PT + f * (H - PT - PB);
    return '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y +
      '" stroke="#1e293b" stroke-width="1"/>' +
      '<text x="' + (PL - 8) + '" y="' + (y + 4) + '" fill="#7d8ba3" font-size="11.5" ' +
      'text-anchor="end" font-family="ui-monospace,monospace">$' +
      (hi - f * (hi - lo)).toFixed(6) + "</text>";
  }).join("");

  const marken = Math.max(2, Math.min(5, Math.floor((W - PL - PR) / 130)));
  const datumTexte = Array.from({ length: marken + 1 }, (_, n) => {
    const i = Math.round((n / marken) * (daten.length - 1));
    const anker = n === 0 ? "start" : n === marken ? "end" : "middle";
    return '<text x="' + X(i) + '" y="' + (H - 10) + '" fill="#7d8ba3" font-size="12" ' +
      'text-anchor="' + anker + '" font-family="ui-monospace,monospace">' +
      achsenText(daten[i].zeit) + "</text>";
  }).join("");

  const linie = daten.map((p, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.preis).toFixed(1)).join("");
  const flaeche = linie + "L" + X(daten.length - 1).toFixed(1) + " " + (H - PB) +
    "L" + X(0).toFixed(1) + " " + (H - PB) + "Z";

  svg.innerHTML =
    '<defs><linearGradient id="prFill" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="' + farbe + '" stop-opacity=".28"/>' +
    '<stop offset="100%" stop-color="' + farbe + '" stop-opacity="0"/>' +
    "</linearGradient></defs>" +
    raster + datumTexte +
    '<path d="' + flaeche + '" fill="url(#prFill)"/>' +
    '<path d="' + linie + '" fill="none" stroke="' + farbe + '" stroke-width="2.2" ' +
    'stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' + X(daten.length - 1) + '" cy="' + Y(daten[daten.length - 1].preis) +
    '" r="4" fill="' + farbe + '"/>' +
    '<line id="prLine" x1="0" y1="' + PT + '" x2="0" y2="' + (H - PB) +
    '" stroke="#5b9cff" stroke-width="1" opacity="0"/>';

  const tip = el("prTip");
  const linieEl = svg.querySelector("#prLine");
  svg.onmousemove = (ev) => {
    const kasten = svg.getBoundingClientRect();
    const x = ((ev.clientX - kasten.left) / kasten.width) * W;
    const i = Math.max(0, Math.min(daten.length - 1,
      Math.round(((x - PL) / (W - PL - PR)) * (daten.length - 1))));
    const p = daten[i];
    linieEl.setAttribute("x1", X(i));
    linieEl.setAttribute("x2", X(i));
    linieEl.setAttribute("opacity", ".7");
    // Ueber die Klasse, nicht ueber display: Das Stylesheet blendet .tip mit
    // opacity ein (.tip.on). Mit display allein blieb der Kasten unsichtbar -
    // korrekt befuellt und positioniert, aber durchsichtig. Die drei anderen
    // Charts der Seite machen es seit jeher richtig, nur dieser nicht.
    tip.classList.add("on");
    tip.style.left = Math.min(kasten.width - 130, Math.max(0, (X(i) / W) * kasten.width - 60)) + "px";
    tip.style.top = ((Y(p.preis) / H) * kasten.height - 52) + "px";
    tip.innerHTML = "<b>$" + p.preis.toFixed(6) + "</b><span>" + punktText(p.zeit) + "</span>";
  };
  svg.onmouseleave = () => {
    tip.classList.remove("on");
    linieEl.setAttribute("opacity", "0");
  };
}

// "Aug 14" wie in allen anderen Charts, nicht "8/14/2026".
const netzDatum = (tag) =>
  new Date(tag + "T00:00:00Z").toLocaleDateString(LOC, { month: "short", day: "numeric", timeZone: "UTC" });

/** Schlichtes Balkenbild der Tagestransaktionen. */
function zeichneNetzChart(tage) {
  const svg = el("netTxChart");
  if (!tage.length) return;
  const B = 600, H = 52;
  const max = Math.max(...tage.map((t) => t.tx)) || 1;
  const breite = B / tage.length;
  svg.innerHTML = tage
    .map((t, i) => {
      const h = Math.max(1, (t.tx / max) * (H - 2));
      return '<rect x="' + (i * breite + breite * 0.14).toFixed(2) +
        '" y="' + (H - h).toFixed(2) +
        '" width="' + (breite * 0.72).toFixed(2) +
        '" height="' + h.toFixed(2) + '" rx="1"><title>' +
        netzDatum(t.day) + ": " + nf(t.tx) + " tx</title></rect>";
    })
    .join("");

  el("netTxRange").textContent = "peak " + kurz(max);
  el("netTxFrom").textContent = netzDatum(tage[0].day);
  el("netTxTo").textContent = netzDatum(tage[tage.length - 1].day);
}

/* ---------- Aftermath ----------------------------------------------------
 *
 * Die Bilanz zum Migrations-Stichtag. Laeuft ab sofort, nicht erst ab dem
 * 31.01.2027: eine Seite, die an ihrem entscheidenden Tag zum ersten Mal
 * Daten sieht, ist an diesem Tag kaputt. Vorher steht in den Spalten fuer
 * "danach" ehrlich nichts - und die Spalte "heute" fuellt sich sofort.
 */

// Zeile der Vergleichstabelle: Beschriftung, Feld im Datensatz, Formatierung.
// Die Formatierung bekommt den ganzen Datenpunkt mit, nicht nur den Wert -
// die Umlaufmenge sagt fuer sich genommen wenig, ihr ANTEIL an der Gesamtmenge
// dagegen alles: er ist der Anteil, der es herueber geschafft hat.
//
// "Still in the bridge" steht hier bewusst nicht mehr: es ist die grosse Zahl
// im Kopf darueber, und zweimal dieselbe Zahl auf einem Bildschirm heisst,
// dass eine davon ueberfluessig ist.
const BILANZ_ZEILEN = [
  ["Migrated supply", "zirkulierend", (v, q) =>
    kurz(v) + " ETN" + teil(q.total_supply ? v / q.total_supply : null)],
  ["ETN price", "preis", (v) => "$" + (v < 0.01 ? v.toFixed(6) : v.toFixed(4))],
  ["Market cap", "marktkapitalisierung", (v) => "$" + kurz(v)],
  ["Wallets ≥ 1M ETN", "holder_1m", (v) => nf(v)],
  ["Wallets ≥ 10M ETN", "holder_10m", (v) => nf(v)],
  ["Top 10 hold", "top10_anteil", (v) => nf(v * 100, 1) + "%"],
  ["Top 100 hold", "top100_anteil", (v) => nf(v * 100, 1) + "%"],
  ["Addresses on chain", "adressen_gesamt", (v) => nf(v)],
];

/** Zweite Zeile in einer Zelle, kleiner und blasser. */
const teil = (anteil) =>
  anteil == null ? "" : '<span class="unten">' + nf(anteil * 100, 1) + "% of all ETN</span>";

// Spalten der Vergleichstabelle. "heute" steht bewusst am Ende: solange der
// Stichtag noch aussteht, ist es die einzige gefuellte Spalte, und dort faellt
// sie am wenigsten aus dem zeitlichen Verlauf.
const BILANZ_SPALTEN = [
  ["T-90", "90 d before"],
  ["T-30", "30 d before"],
  ["T0", "Deadline"],
  ["T+30", "30 d after"],
  ["T+90", "90 d after"],
  ["heute", "Today"],
];


/**
 * Beschriftet Chart und Fortschrittsbalken nach der Reihe, die gerade gezeigt
 * wird - den 120 Tagen aus der Uebersicht oder der ganzen Historie.
 */
function migVerlaufBeschriften() {
  const v = MIG.punkte;
  const m = MIG.opts;
  if (!m || v.length < 2) return;

  el("chartRange").textContent =
    new Date(v[0].day).toLocaleDateString(LOC) + " - " +
    new Date(v[v.length - 1].day).toLocaleDateString(LOC) +
    (Date.now() < Date.parse(m.deadline + "T00:00:00Z") + 86400000
      ? " · deadline " + new Date(m.deadline).toLocaleDateString(LOC)
      : "");
  const diff = v[v.length - 1].etn - v[0].etn;
  const c = el("chartDelta");
  c.textContent = kurz(diff, true) + " ETN";
  c.className = "num " + (diff < 0 ? "up" : "down"); // a shrinking bridge is good news

  // Wo stand der Balken am Anfang der gezeigten Reihe? Der Abstand zwischen
  // Marke und Balkenkante ist der gesamte Fortschritt dieses Zeitraums.
  if (m.totalSupply > 0) {
    const damals = Math.max(0, Math.min(100, (1 - v[0].etn / m.totalSupply) * 100));
    const marke = el("migVor");
    marke.hidden = false;
    marke.style.left = damals.toFixed(2) + "%";
    const tage = Math.round((Date.parse(v[v.length - 1].day) - Date.parse(v[0].day)) / 86400000);
    // Ueber ein halbes Jahr sagt ein Datum mehr als eine Zahl von Tagen.
    const wann = tage > 180
      ? new Date(v[0].day).toLocaleDateString(LOC, { month: "short", year: "numeric" })
      : tage + " days ago";
    el("migVorLbl").innerHTML =
      '<span class="dim3">' + wann + ": <b>" + nf(damals, 1) + "%</b></span>";
  }
}

/**
 * Der Bridge-Bestand seit Anfang 2026 oder (All) seit dem Start der Bridge.
 * Kommt erst, wenn der Durchgang durch die Historie weit genug gelesen hat -
 * bis dahin bleibt der Chart bei den 120 Tagen aus der Uebersicht.
 */
async function ladeBridgeVerlauf() {
  const bereich = MIG.bereich;
  const zeigen = (punkte) => {
    MIG.punkte = punkte;
    migSchalter();
    zeichneMigration();
    migVerlaufBeschriften();
  };
  // Schon einmal geladen: sofort umschalten, der frische Stand kommt hinterher.
  if (MIG.voll[bereich]) zeigen(MIG.voll[bereich]);
  else migSchalter();
  let d = null;
  try {
    d = await hole("/api/bridge-verlauf" + (bereich === "all" ? "?period=all" : ""));
  } catch {}
  if (!d?.vollstaendig || (d.punkte ?? []).length < 2) {
    // Die ganze Historie gibt es (noch) nicht: zurueck auf 2026, dessen Chart
    // ohnehin noch steht.
    if (bereich !== "2026" && !MIG.voll[bereich] && MIG.bereich === bereich) {
      MIG.bereich = "2026";
      migSchalter();
    }
    return;
  }
  MIG.voll[bereich] = d.punkte;
  // Waehrend des Ladens umgeschaltet? Dann gehoert der Chart dem anderen Bereich.
  if (MIG.bereich === bereich) zeigen(d.punkte);
}

// ---------- Chain ----------
// Liest nur /api/chain (src/index.js, chain()). Daraus kommen der
// Wochenrueckblick - der steht in der Overview - sowie Tokens und Contracts.
const CHAIN = { daten: null, text: "", bild: "week-radar" };
// Overview und Chain-Reiter brauchen dieselbe Antwort: einmal holen, beide
// zeichnen lassen. /api/chain liegt ohnehin eine Stunde im Edge-Zwischenspeicher.
let chainLaeuft = null;
const chainDaten = () => (chainLaeuft ??= ladeChain());

async function ladeChain() {
  try {
    CHAIN.daten = await hole("/api/chain");
  } catch (e) {
    for (const id of ["chainWoche", "chainTokens", "chainNeu"]) {
      el(id).innerHTML = '<div class="empty">' + esc(fehlerText(e)) + "</div>";
    }
    return;
  }
  zeichneChainWoche();
  zeichneChainTokens();
  zeichneChainNeu();
}

const chainDatum = (tag) =>
  new Date(tag + "T00:00:00Z").toLocaleDateString(LOC, { month: "short", day: "numeric", timeZone: "UTC" });
const chainZahl = (v) => (v >= 10000 ? kurz(v) : nf(v, v < 10 && v % 1 ? 1 : 0));

// Veraenderung zur Vorwoche - nur, wenn beide Wochen volle sieben Tage haben.
function chainVergleich(w) {
  if (!w?.woche || !w.vorwoche || w.woche.tage < 7 || w.vorwoche.tage < 7 || !(w.vorwoche.summe > 0)) return null;
  return ((w.woche.summe - w.vorwoche.summe) / w.vorwoche.summe) * 100;
}
function chainProzent(p) {
  if (p == null) return "";
  if (Math.abs(p) < 1) return '<span class="dim3">same as last week</span>';
  return '<span class="' + (p > 0 ? "up" : "down") + '">' + (p > 0 ? "▲ " : "▼ ") +
    nf(Math.abs(p), Math.abs(p) < 10 ? 1 : 0) + "% vs. last week</span>";
}


// Das Bild zum Wochenrueckblick richtet sich nach der groessten Nachricht der
// Woche. Trifft nichts davon zu, zeigt das Radarbild einfach die Woche an sich.
function wocheBild(d) {
  const m = d.migration;
  if (m?.vorwoche > 0 && (m.woche - m.vorwoche) / m.vorwoche >= 0.25) return "week-bridge";
  if (Math.abs(d.bewegung?.etn ?? 0) >= 10e6) return "week-whale";
  if (chainVergleich(d.tx) >= 10) return "week-busy";
  return "week-radar";
}

function zeichneChainWoche() {
  const d = CHAIN.daten;
  const box = el("chainWoche");
  if (!d) return;
  el("chainWocheRange").textContent = chainDatum(d.woche.von) + " - " + chainDatum(d.woche.bis);
  const mit = (p) => (p == null ? "" : " · " + chainProzent(p));
  // [Emoji, HTML fuer die Seite, Klartext fuer den geteilten Post]
  const fakten = [];
  if (d.preis) {
    const p = ((d.preis.ende - d.preis.start) / d.preis.start) * 100;
    const flach = Math.abs(p) < 0.1;
    const pfeil = flach ? "" : p > 0 ? "▲ " : "▼ ";
    const wert = pfeil + (p > 0 ? "+" : flach ? "" : "-") + nf(Math.abs(p), 1) + "%";
    fakten.push(["💰",
      "ETN price now <b>" + wiPreis(d.preis.ende) + "</b> · " +
        (flach ? '<span class="dim3">unchanged in 7 days</span>'
          : '<span class="' + (p > 0 ? "up" : "down") + '">' + wert + " in 7 days</span>") +
        ' <span class="dim3">(low ' + wiPreis(d.preis.tief) + ", high " + wiPreis(d.preis.hoch) + ")</span>",
      "ETN price now " + wiPreis(d.preis.ende) + (flach ? ", unchanged in 7 days" : " (" + wert + " in 7 days)")]);
  }
  if (d.tx?.woche) {
    const t = kurz(d.tx.woche.summe) + " transactions";
    fakten.push(["📈", "<b>" + t + "</b>" + mit(chainVergleich(d.tx)), t]);
  }
  if (d.boersen && Math.abs(d.boersen.netto) >= 10000) {
    const n = d.boersen.netto;
    const t = kurz(Math.abs(n)) + " ETN " + (n > 0 ? "moved onto exchanges" : "left the exchanges") + " (net)";
    // Traegt eine Boerse den Grossteil, steht sie dabei - ein einzelner Umzug
    // ist etwas anderes als viele Anleger.
    const g = d.boersen.groesste;
    const davon = g && Math.sign(g.netto) === Math.sign(n) && Math.abs(g.netto) >= Math.abs(n) * 0.5
      ? kurz(Math.abs(g.netto)) + " of it " + (n > 0 ? "to " : "from ") + g.label
      : "";
    fakten.push(["🏦", "<b>" + t + "</b>" + (davon ? ' <span class="dim3">· ' + esc(davon) + "</span>" : ""),
      t + (davon ? ", " + davon : "")]);
  }
  if (d.migration) {
    const m = d.migration;
    const p = m.vorwoche > 0 ? ((m.woche - m.vorwoche) / m.vorwoche) * 100 : null;
    fakten.push(["🌉", "<b>" + kurz(m.woche) + " ETN</b> migrated out of the bridge" + mit(p),
      kurz(m.woche) + " ETN migrated out of the bridge"]);
  }
  if (d.bewegung) {
    const b = d.bewegung;
    const verb = b.etn < 0 ? "moved out" : "received";
    const betrag = kurz(Math.abs(b.etn)) + " ETN";
    fakten.push(["🐋",
      'Biggest move: <a href="/wallet/' + esc(b.address) + '" data-wallet="' + esc(b.address) + '">' +
        (b.label ? esc(b.label) : kurzAdr(b.checksum_hash ?? b.address)) + "</a> " + verb + " <b>" + betrag + "</b>",
      "Biggest move: " + (b.label ?? b.address.slice(0, 8) + "…" + b.address.slice(-6)) + " " + verb + " " + betrag]);
  }
  if (d.contracts?.woche?.summe) {
    const t = nf(d.contracts.woche.summe) + " contracts";
    fakten.push(["🧱", "<b>" + t + "</b> verified", t + " verified"]);
  }
  const bester = (d.tokens ?? []).filter((t) => t.holders_7d > 0).sort((a, b) => b.holders_7d - a.holders_7d)[0];
  if (bester) {
    fakten.push(["💎", "<b>" + esc(bester.symbol) + "</b> gained the most holders: <b>+" + nf(bester.holders_7d) + "</b>",
      bester.symbol + " gained the most holders: +" + nf(bester.holders_7d)]);
  }

  if (!fakten.length) {
    CHAIN.text = "";
    box.innerHTML = '<div class="empty">Collecting data for the first week&hellip;</div>';
    return;
  }
  // Gleicher Aufbau wie die anderen Posts: Haken, Zahlen je Zeile, Schlusszeile.
  CHAIN.text = [
    "🗓️ This week on Electroneum (" + el("chainWocheRange").textContent + ")",
    "",
    fakten.map((f) => f[0] + " " + f[2]).join("\n"),
    "",
    "Seven days, one chain, all of it public.",
    "",
    "Watch it live on ETN Radar 👇",
  ].join("\n");
  CHAIN.bild = wocheBild(d);
  box.innerHTML = '<ul class="wochefakten">' +
    fakten.map((f) => "<li><i>" + f[0] + "</i><span>" + f[1] + "</span></li>").join("") + "</ul>" +
    '<div class="sharebar"><button data-teilen>📢 Share this week</button></div>';
}

el("chainWoche").addEventListener("click", (e) => {
  const w = e.target.closest("a[data-wallet]");
  if (w) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    investigateAddress(w.dataset.wallet);
    return;
  }
  if (!e.target.closest("[data-teilen]") || !CHAIN.text) return;
  // Derselbe Dialog wie "Share" beim Wallet: Vorschau, dann X oder Telegram.
  // Alle vier Bilder zur Wahl, vorgewaehlt das zur groessten Nachricht. Die
  // Automatik allein zeigte fast immer die Bruecke: die Migration schwankt von
  // Woche zu Woche um Hunderte Prozent.
  const bilder = ["bridge", "whale", "busy", "radar"];
  shareTextOeffnen({
    titel: "📢 Share this week",
    varianten: bilder.map((b) => [b, CHAIN.text, "week-" + b]),
    wahl: Math.max(0, bilder.indexOf(CHAIN.bild.replace("week-", ""))),
    url: location.origin + "/",
  });
});

// Token-Karten: Preis, 24-Stunden-Veraenderung, kleine Wochenkurve, Holder
// und Marktkapitalisierung. Preise und Kurve kommen von ElectroSwap (einmal
// taeglich geholt), Holder vom Explorer aus unserer eigenen Tagesreihe.
function tokenPreisText(v) {
  if (!(v > 0)) return "—";
  if (v >= 1) return "$" + nf(v, 2);
  if (v >= 0.01) return "$" + nf(v, 4);
  if (v >= 0.0001) return "$" + nf(v, 6);
  // Sehr kleine Preise als $0.0₈535 statt einer Nullwueste.
  const exp = Math.floor(Math.log10(v));
  const nullen = -exp - 1;
  const ziffern = Math.round(v * Math.pow(10, nullen + 3));
  return "$0.0" + String(nullen).split("").map((z) => "₀₁₂₃₄₅₆₇₈₉"[Number(z)]).join("") + ziffern;
}

// Marktkapitalisierung der Tokens: wiCap rundet alles unter einer Million auf
// $0M - bei Tokens ist genau das der haeufige Fall.
function capText(v) {
  if (!(v > 0)) return "";
  if (v >= 1e9) return "$" + nf(v / 1e9, 2) + "B";
  if (v >= 1e6) return "$" + nf(v / 1e6, v < 1e7 ? 1 : 0) + "M";
  return "$" + kurz(v);
}

/** Kleine Kurve ohne Achsen - nur die Richtung der letzten sieben Tage. */
function sparkPfad(werte, breite = 108, hoehe = 30) {
  if (!werte || werte.length < 2) return "";
  const min = Math.min(...werte), max = Math.max(...werte);
  const spanne = max - min || Math.abs(max) * 0.05 || 1;
  return werte.map((v, i) => {
    const x = (i / (werte.length - 1)) * breite;
    const y = hoehe - ((v - min) / spanne) * (hoehe - 4) - 2;
    return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
  }).join(" ");
}

function zeichneChainTokens() {
  const liste = CHAIN.daten?.tokens ?? [];
  const box = el("chainTokens");
  if (!liste.some((t) => t.holders != null || t.preis_usd != null)) {
    box.innerHTML = '<div class="empty">Collecting token data&hellip;</div>';
    return;
  }
  box.innerHTML = liste.map((t) => {
    const p = t.preis_24h;
    const rauf = (p ?? 0) >= 0;
    const farbe = p == null ? "dim3" : rauf ? "up" : "down";
    const wandel = p == null ? "" :
      '<span class="' + farbe + '">' + (rauf ? "▲ +" : "▼ ") + nf(Math.abs(p), 1) + "% 24h</span>";
    const d = t.holders_7d;
    const holder = t.holders == null ? "" :
      "<b>" + nf(t.holders) + "</b> holders" +
      (d ? ' <span class="' + (d > 0 ? "up" : "down") + '">' + (d > 0 ? "+" : "−") + nf(Math.abs(d)) + "</span>" : "");
    const pfad = sparkPfad(t.kurve);
    const kurve = pfad
      ? '<svg class="spark" viewBox="0 0 108 30" preserveAspectRatio="none" aria-hidden="true">' +
        '<path d="' + pfad + '" fill="none" stroke="' + (rauf ? "#22d3a7" : "#f4635e") + '" stroke-width="2" ' +
        'stroke-linejoin="round" stroke-linecap="round"/></svg>'
      : '<span class="dim3 keinekurve">no chart yet</span>';
    return '<div class="tokkarte">' +
      '<div class="kopf"><img src="/assets/tokens/' + esc(t.logo) + '" alt="" width="34" height="34" loading="lazy">' +
      '<span class="nm"><b>' + esc(t.symbol) + "</b><span>" + esc(t.name) + "</span></span></div>" +
      '<div class="preis"><b class="num">' + tokenPreisText(t.preis_usd) + "</b>" + wandel + "</div>" +
      kurve +
      '<div class="fuss"><span>' + holder + "</span>" +
      (t.cap_usd ? '<span class="dim3">Cap ' + capText(t.cap_usd) + "</span>" : "") + "</div>" +
      '<div class="links"><a href="' + esc(t.trade) + '" target="_blank" rel="noopener">Trade ↗</a>' +
      '<a href="https://blockexplorer.electroneum.com/token/' + esc(t.address) +
      '" target="_blank" rel="noopener">Explorer ↗</a></div></div>';
  }).join("");

  // Top-Mover der Woche: groesste Veraenderung ueber sieben Tage.
  el("topMover")?.remove();
  const mover = [...liste].filter((t) => t.preis_7d != null).sort((a, b) => b.preis_7d - a.preis_7d)[0];
  if (mover && Math.abs(mover.preis_7d) >= 1) {
    const rauf = mover.preis_7d > 0;
    box.insertAdjacentHTML("beforebegin",
      '<div class="topmover" id="topMover">' + (rauf ? "🚀" : "🧊") + " <b>" + esc(mover.symbol) + "</b> " +
      (rauf ? "is the top mover this week" : "leads the week") +
      ' <span class="' + (rauf ? "up" : "down") + '">' + (rauf ? "▲ +" : "▼ ") + nf(Math.abs(mover.preis_7d), 1) + "%</span>" +
      '<span class="dim3"> · 7 days</span></div>');
  }
  zeichneHolderChart();
  zeichneNeuGelistet();
  zeichneNftListe();
}

// Tokens, die neu auf ElectroSwap aufgetaucht sind.
function zeichneNeuGelistet() {
  const liste = CHAIN.daten?.neu_gelistet ?? [];
  const wrap = el("neuGelistetWrap");
  if (!liste.length) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";
  el("chainNeuGelistet").innerHTML = liste.map((t) =>
    '<a class="tokrow" href="https://blockexplorer.electroneum.com/token/' + esc(t.address) +
    '" target="_blank" rel="noopener">' +
    '<span class="neuicon">✨</span>' +
    '<span class="wer"><span class="nm">' + esc(t.name ?? t.symbol ?? kurzAdr(t.address)) +
    "<small>" + esc(t.symbol ?? "") + "</small></span>" +
    '<span class="meta">listed ' + zeitHer(t.zuerst_gesehen) + " ago</span></span>" +
    '<span class="zahl"><b class="num">' + (t.preis_usd ? tokenPreisText(t.preis_usd) : "—") + "</b></span></a>"
  ).join("");
}

// Alle NFT-Sammlungen des Marktplatzes samt Bodenpreis.
function zeichneNftListe() {
  const d = CHAIN.daten?.nft;
  const wrap = el("nftWrap");
  if (!d?.sammlungen?.length) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";
  const s = d.stats ?? {};
  const kachel = (wert, text) => '<div class="nftkachel"><b class="num">' + wert + "</b><span>" + text + "</span></div>";
  const zahlen = [
    s.collections != null ? kachel(nf(s.collections), "collections") : "",
    s.listings != null ? kachel(nf(s.listings), "open listings") : "",
    s.owners != null ? kachel(nf(s.owners), "owners") : "",
    s.volume != null ? kachel(kurz(Number(s.volume)) + " ETN", "traded") : "",
  ].filter(Boolean).join("");
  el("nftStats").innerHTML = zahlen;
  el("nftStats").style.display = zahlen ? "" : "none";
  const preis = PREIS_JETZT ?? 0;
  el("nftListe").innerHTML = d.sammlungen.map((c) =>
    '<a class="tokrow" href="https://blockexplorer.electroneum.com/token/' + esc(c.address) +
    '" target="_blank" rel="noopener">' +
    '<span class="neuicon">🖼️</span>' +
    '<span class="wer"><span class="nm">' + esc(c.name ?? kurzAdr(c.address)) +
    "<small>" + esc(c.symbol ?? "") + "</small></span>" +
    '<span class="meta">' + (c.supply != null ? nf(c.supply) + " pieces" : "") +
    (c.besitzer != null ? " · " + nf(c.besitzer) + " owners" : "") +
    (c.angebote != null ? " · " + nf(c.angebote) + " listed" : "") + "</span></span>" +
    '<span class="zahl">' + (c.floor_etn
      ? '<b class="num">' + kurz(c.floor_etn) + " ETN</b><span>" +
        (preis > 0 ? "floor ≈ " + dollar(c.floor_etn * preis) : "floor") + "</span>"
      : '<span class="dim3">no listing</span>') + "</span></a>"
  ).join("");
}

// ---------- Holder-Verlauf ----------
// Eine Linie je Token, umschaltbar. Die Reihe kommt aus token_tage und kostet
// keine einzige zusaetzliche Anfrage.
const HOLDER = { token: null };

function zeichneHolderChart(wahl) {
  const liste = (CHAIN.daten?.tokens ?? []).filter((t) => (t.holder_reihe ?? []).length >= 2);
  const box = el("holderTabs");
  if (!liste.length) {
    box.innerHTML = "";
    el("holderHolder").innerHTML = '<div class="empty">Not enough holder history yet</div>';
    return;
  }
  if (wahl) HOLDER.token = wahl;
  if (!liste.some((t) => t.symbol === HOLDER.token)) HOLDER.token = liste[0].symbol;
  box.innerHTML = liste.map((t) =>
    '<button class="ghost' + (t.symbol === HOLDER.token ? " on" : "") + '" data-holder="' + esc(t.symbol) + '">' +
    esc(t.symbol) + "</button>").join("");
  const gewaehlt = liste.find((t) => t.symbol === HOLDER.token);
  if (!el("holderChart")) {
    el("holderHolder").innerHTML = '<svg class="chart" id="holderChart"></svg><div class="tip"></div>';
  }
  const punkte = gewaehlt.holder_reihe.map((h) => ({ day: h.day, etn: h.n }));
  el("holderChart")._usd = false;
  el("holderChart")._einheit = "holders";
  zeichneChart(el("holderChart"), punkte);
}

el("holderTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-holder]");
  if (b) zeichneHolderChart(b.dataset.holder);
});
beobachte("holderHolder", () => { if (el("holderChart")?._punkte) zeichneChart(el("holderChart")); });

function zeichneChainNeu() {
  const c = CHAIN.daten?.contracts;
  const box = el("chainNeu");
  const gruppen = c?.gruppen ?? [];
  if (!gruppen.length) {
    box.innerHTML = '<div class="empty">No newly verified contracts in the last 7 days.</div>';
    return;
  }
  box.innerHTML = gruppen.map((g) =>
    '<a class="tokrow" href="' + EXPLORER + esc(g.address) + '" target="_blank" rel="noopener">' +
    '<span class="neuicon">' + esc((g.name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase()) + "</span>" +
    '<span class="wer"><span class="nm">' + esc(g.name) + (g.anzahl > 1 ? "<small>×" + nf(g.anzahl) + "</small>" : "") + "</span>" +
      '<span class="meta">verified ' + zeitHer(g.neuste) + " ago</span></span>" +
    '<span class="zahl"><b class="num">' + (g.tx > 0 ? nf(g.tx) : "—") + "</b><span>" +
      (g.tx > 0 ? "transactions" : "not used yet") + "</span></span></a>"
  ).join("") + (c.weitere ? '<div class="tokmehr dim3">+ ' + nf(c.weitere) + " more</div>" : "");
}

// ---------- What if (Marktkapitalisierung vergleichen) ----------
//
// Reine Division: fremde Marktkapitalisierung geteilt durch die ETN-Menge.
// Keine Vorhersage, und nirgends steht "wird" - deshalb auch der Hinweis auf
// Quelle und Stand direkt unter dem Ergebnis.
//
// Die Coins kommen einmal beim Oeffnen des Reiters (/api/whatif, aus der
// eigenen Datenbank). Gesucht wird danach im Browser, ohne weitere Anfragen.
const WI = { daten: null, coin: null, nurMigriert: false };

// [Stimmung, Bild, Rechenzeile, Schlusszeile vor dem Link]
// Aufbau wie bei allen Posts: Haken, Zahlen je Zeile, ein Satz, Schlusszeile.
// zahl(coin, neuerPreis, faktor, heute) baut den mittleren Block.
const WI_TEXTE = [
  ["calm", "whatif-scale",
    (c, p, x, h) => ["📊 What if ETN had " + c + "'s market cap?", "",
      "💰 " + h + " per ETN today", "🎯 With " + c + "'s cap: " + p + " per ETN", "✖️ That is ×" + x + " from here"].join("\n"),
    "Not a forecast, just math. Try any coin on ETN Radar 👇"],
  ["proud", "whatif-dream",
    (c, p, x, h) => ["🔭 Imagine ETN as big as " + c + ".", "",
      "💰 " + h + " per ETN today", "📈 At " + c + "'s size: " + p + " per ETN", "✖️ ×" + x + " from where we are"].join("\n"),
    "Dreaming is free, the math is on ETN Radar 👇"],
  ["funny", "whatif-napkin",
    (c, p, x, h) => ["🧮 Napkin math, " + c + " edition.", "",
      "💰 ETN today: " + h, "🎯 At " + c + "'s market cap: " + p, "✖️ That is a ×" + x + " napkin"].join("\n"),
    "My calculator needed a minute. Do yours on ETN Radar 👇"],
];

// Kurse unter einem Cent brauchen mehr Stellen, sonst steht ueberall $0.00.
function wiPreis(v) {
  if (!isFinite(v) || v <= 0) return "—";
  if (v >= 1000) return "$" + nf(v, 0);
  if (v >= 1) return "$" + nf(v, 2);
  if (v >= 0.01) return "$" + nf(v, 4);
  return "$" + nf(v, 6);
}
const wiCap = (v) => (v >= 1e12 ? "$" + nf(v / 1e12, 2) + "T" : v >= 1e9 ? "$" + nf(v / 1e9, 2) + "B" : "$" + nf(v / 1e6, 0) + "M");
const wiFaktor = (x) => (x >= 100 ? nf(x, 0) : x >= 10 ? nf(x, 1) : nf(x, 2));

async function ladeWhatif() {
  try {
    WI.daten = await hole("/api/whatif");
  } catch (e) {
    el("wiErgebnis").innerHTML = '<div class="empty">' + esc(fehlerText(e)) + "</div>";
    el("wiSchnell").innerHTML = "";
    return;
  }
  wiSchnellZeigen();
  // Vorgewaehlt der groesste Coin: das Ergebnis ist sofort da, ohne Klick.
  wiWaehlen(WI.daten.schnell[0]?.ids[0] ?? WI.daten.coins[0]?.i);
  wiChipsZeigen();
}

// Jeder Bereich hat seine Farbe - dieselbe in Ueberschrift, Rang und Balken,
// auch bei Suchtreffern. So sieht man sofort, in welcher Liga ein Coin spielt.
const WI_BEREICHE = [
  ["Top 10", 10, "#fbbf24"], ["Top 30", 30, "#a78bfa"], ["Top 50", 50, "#5b9cff"],
  ["Top 100", 100, "#22d3a7"], ["Top 150", 150, "#4ade80"], ["Top 300", 300, "#fb923c"],
];
const wiBereich = (rang) => WI_BEREICHE.find(([, bis]) => rang <= bis) ?? WI_BEREICHE[WI_BEREICHE.length - 1];

// Balken auf log-Skala: von der kleinsten bis zur groessten Marktkapitalisierung
// der Liste. Linear waere alles ausser Bitcoin ein Strich.
function wiBalken(cap) {
  const caps = WI.daten.coins.map((c) => c.c);
  const lo = Math.log10(Math.min(...caps)), hi = Math.log10(Math.max(...caps));
  return Math.max(4, ((Math.log10(cap) - lo) / (hi - lo || 1)) * 100);
}

const wiZeile = (c) => {
  const menge = wiMenge();
  return '<button type="button" class="wizeile' + (c.i === WI.coin?.i ? " on" : "") + '" data-coin="' + esc(c.i) +
    '" style="--f:' + wiBereich(c.r)[2] + '">' +
    '<span class="rang num">' + nf(c.r) + "</span>" +
    '<span class="nm"><span class="name">' + esc(c.n) + " <small>" + esc(c.s) + "</small></span>" +
      '<i class="wibalken"><b style="width:' + wiBalken(c.c).toFixed(1) + '%"></b></i></span>' +
    '<span class="cap num">' + wiCap(c.c) +
      (menge > 0 ? "<small>" + wiPreis(c.c / menge) + " / ETN</small>" : "") + "</span></button>";
};

// Je Bereich (Top 10, Top 30 ...) die bekanntesten Namen - so sieht man auf
// einen Blick, wie weit die Marktkapitalisierungen auseinanderliegen.
function wiSchnellZeigen() {
  const box = el("wiSchnell");
  const gruppen = WI.daten.schnell
    .map((g) => ({ titel: g.titel, coins: g.ids.map((id) => WI.daten.coins.find((c) => c.i === id)).filter(Boolean) }))
    .filter((g) => g.coins.length);
  if (!gruppen.length) {
    box.innerHTML = '<div class="empty">No market caps yet.</div>';
    return;
  }
  let vorher = 0;
  box.innerHTML = gruppen
    .map((g) => {
      const [titel, bis, farbe] = WI_BEREICHE.find(([t]) => t === g.titel) ?? [g.titel, 0, "#5b9cff"];
      const kopf = '<div class="wigruppe" style="--f:' + farbe + '"><span class="pill">' + esc(titel) + "</span>" +
        '<span class="bereich">rank ' + (vorher + 1) + " - " + bis + "</span></div>";
      vorher = bis;
      return '<div class="wiblock" style="--f:' + farbe + '">' + kopf + g.coins.map(wiZeile).join("") + "</div>";
    })
    .join("");
}

function wiWaehlen(id) {
  const coin = WI.daten?.coins.find((c) => c.i === id);
  if (!coin) return;
  WI.coin = coin;
  wiSchnellZeigen();
  wiTrefferZeigen();
  wiErgebnisZeigen();
}

function wiTrefferZeigen() {
  const box = el("wiTreffer");
  const q = el("wiQ").value.trim().toLowerCase();
  el("wiQ").parentElement.querySelector(".leeren").hidden = !q;
  if (!q) {
    box.innerHTML = '<div class="wihinweis dim3">' + nf(WI.daten?.coins.length ?? 0) +
      " coins, ranked by market cap. Type a name or symbol.</div>";
    return;
  }
  const treffer = (WI.daten?.coins ?? [])
    .filter((c) => c.n.toLowerCase().includes(q) || c.s.toLowerCase().includes(q))
    // Wer "xrp" tippt, will XRP - Treffer im Symbol zuerst, dann nach Rang.
    .sort((a, b) => {
      const g = (c) => (c.s.toLowerCase() === q ? 0 : c.s.toLowerCase().startsWith(q) ? 1 : c.n.toLowerCase().startsWith(q) ? 2 : 3);
      return g(a) - g(b) || a.r - b.r;
    })
    .slice(0, 12);
  box.innerHTML = treffer.length
    ? treffer.map(wiZeile).join("")
    : /^(etn|electr)/.test(q)
      ? '<div class="wihinweis dim3">That\'s ETN itself' +
        (WI.daten?.etn.rang ? " - rank #" + nf(WI.daten.etn.rang) + " by market cap" : "") + ". Pick another coin to compare.</div>"
      : '<div class="wihinweis dim3">Nothing found. Only the top 300 by market cap are listed.</div>';
}

// Menge, durch die geteilt wird: alles, oder nur was die Bridge verlassen hat.
const wiMenge = () => (WI.nurMigriert ? WI.daten.etn.migriert : WI.daten.etn.gesamt);

function wiRechnung() {
  const c = WI.coin;
  const menge = wiMenge();
  const preis = WI.daten.etn.preis;
  if (!c || !(menge > 0) || !(preis > 0)) return null;
  const neu = c.c / menge;
  return { coin: c, preis: neu, faktor: neu / preis, menge };
}

// Kuerzel im farbigen Kreis statt Logo - fremde Logos hiessen eine Anfrage
// an einen fremden Server je Coin.
const wiMarke = (text, farbe) =>
  '<span class="wimarke" style="--f:' + farbe + '">' + esc(text) + "</span>";

function wiErgebnisZeigen() {
  const r = wiRechnung();
  const box = el("wiErgebnis");
  if (!r) {
    box.innerHTML = '<div class="empty">Pick a coin to see the number.</div>';
    return;
  }
  const farbe = wiBereich(r.coin.r)[2];
  box.style.setProperty("--f", farbe);
  const stand = WI.daten.stand
    ? new Date(WI.daten.stand).toLocaleDateString(LOC, { day: "numeric", month: "short", year: "numeric" })
    : "—";
  const etnPreis = WI.daten.etn.preis;
  const etnCap = etnPreis * r.menge;
  // Rang bei CoinGecko - gilt fuer die ganze Menge, beim Umschalter auf
  // "Migrated" waere er eine andere Zahl und bleibt darum weg.
  const etnRang = WI.nurMigriert ? null : WI.daten.etn.rang;
  // Linear, bewusst: zwei Balken nebeneinander liest jeder als Verhaeltnis.
  // Auf log-Skala saehe ETN wie ein Drittel von Stellar aus, obwohl Stellar
  // 300-mal so gross ist. Der duenne Strich IST hier die Aussage.
  const groesster = Math.max(r.coin.c, etnCap);
  const balken = (cap) => Math.max(0.8, (cap / groesster) * 100);
  const symbol = r.coin.s.length > 4 ? r.coin.s.slice(0, 4) : r.coin.s;

  box.innerHTML =
    '<div class="widuell">' +
      '<div class="wiseite">' + wiMarke("ETN", "#5b9cff") +
        '<div><b>Electroneum</b><span class="num">' + (etnRang ? "#" + nf(etnRang) + " · " : "") + "ETN</span>" +
        '<span class="num">cap ' + wiCap(etnCap) + "</span></div></div>" +
      '<span class="wipfeil" aria-hidden="true">⇢</span>' +
      '<div class="wiseite">' + wiMarke(symbol, farbe) +
        "<div><b>" + esc(r.coin.n) + '</b><span class="num">#' + nf(r.coin.r) + " · " + esc(r.coin.s) + '</span><span class="num">cap ' + wiCap(r.coin.c) + "</span></div></div>" +
    "</div>" +
    '<div class="wihaupt">' +
      '<div class="wifrage">If ETN had <b>' + esc(r.coin.n) + "</b>'s market cap</div>" +
      '<div class="wizahl"><span class="v num">' + wiPreis(r.preis) + '</span><span class="k">per ETN</span></div>' +
      '<span class="wifaktor num">×' + wiFaktor(r.faktor) + '</span> <span class="k">from ' + wiPreis(etnPreis) + " today" +
        (etnRang ? " · rank #" + nf(etnRang) + " → #" + nf(r.coin.r) : "") + "</span>" +
    "</div>" +
    '<div class="wigroesse" aria-label="Market cap comparison">' +
      '<div class="wibalkenzeile"><span class="nm">ETN today</span><i><b style="width:' + balken(etnCap).toFixed(1) +
        '%;background:#5b9cff"></b></i><span class="num">' + wiCap(etnCap) + "</span></div>" +
      '<div class="wibalkenzeile"><span class="nm">' + esc(r.coin.n) + '</span><i><b style="width:' + balken(r.coin.c).toFixed(1) +
        '%"></b></i><span class="num">' + wiCap(r.coin.c) + "</span></div>" +
    "</div>" +
    '<div class="wiumschalter"><span class="k">Count</span>' +
      '<div class="wisegment" role="radiogroup" aria-label="Which ETN supply to divide by">' +
        '<button type="button" role="radio" aria-checked="' + !WI.nurMigriert + '" class="' + (WI.nurMigriert ? "" : "on") +
          '" data-menge="gesamt">All ' + kurz(WI.daten.etn.gesamt) + "</button>" +
        '<button type="button" role="radio" aria-checked="' + WI.nurMigriert + '" class="' + (WI.nurMigriert ? "on" : "") +
          '" data-menge="migriert">Migrated ' + kurz(WI.daten.etn.migriert) + "</button>" +
      "</div>" +
      '<button type="button" class="infoBtn" data-info="' +
        esc('Every ETN in existence is counted by default. "Migrated" leaves out the coins that are still sitting in the ' +
          "migration bridge. That is an estimate: nobody knows how many of them will ever be claimed, and each one that is claimed " +
          "later lowers the price per ETN again.") + '">ⓘ</button></div>' +
    '<div class="wifuss"><button data-teilen>📢 Share this</button>' +
      '<span class="dim3">Market caps: CoinGecko, ' + esc(stand) + ". Division, not a forecast.</span></div>";
  // Neuer Coin oder andere Menge: der eigene Wert rechnet mit.
  wiWertZeigen();
}

el("wiQ").addEventListener("input", wiTrefferZeigen);
el("wiQ").parentElement.querySelector(".leeren").addEventListener("click", () => {
  el("wiQ").value = "";
  wiTrefferZeigen();
  el("wiQ").focus();
});
for (const id of ["wiSchnell", "wiTreffer"]) {
  el(id).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-coin]");
    if (!b) return;
    // Aus der Suche gewaehlt: Liste zuklappen, das Ergebnis steht direkt darunter.
    if (id === "wiTreffer") el("wiQ").value = "";
    wiWaehlen(b.dataset.coin);
  });
}
el("wiErgebnis").addEventListener("click", (e) => {
  const m = e.target.closest("button[data-menge]");
  if (m) {
    WI.nurMigriert = m.dataset.menge === "migriert";
    // Die Preise je ETN in den Listen haengen an derselben Menge.
    wiSchnellZeigen();
    wiTrefferZeigen();
    wiErgebnisZeigen();
    return;
  }
  if (!e.target.closest("[data-teilen]")) return;
  const r = wiRechnung();
  if (!r) return;
  // Der Hinweis gehoert zur Zahl, nicht hinter die Aufforderung vor dem Link.
  const zusatz = WI.nurMigriert ? "\nCounting migrated ETN only - an estimate." : "";
  const varianten = WI_TEXTE.map(([ton, bild, zahl, schluss]) =>
    [ton, zahl(r.coin.n, wiPreis(r.preis), wiFaktor(r.faktor), wiPreis(WI.daten.etn.preis)) +
      zusatz + "\n\n" + schluss, bild]);
  shareTextOeffnen({
    titel: "📢 Share this comparison",
    varianten,
    url: location.origin + "/whatif",
  });
});

// --- Eigener Bestand: was waere er wert? -------------------------------------
// Eine Zahl oder eine Adresse ins Feld; Adressen holt /api/search (aus der
// Datenbank, ausserhalb der Top N einmal beim Explorer aus dem Minutenbudget).
// Die gemerkten Wallets stehen als Schnellknoepfe darunter. Bewusst "worth"
// statt "profit" - das hier ist eine Rechnung, kein Versprechen.
WI.eigen = null; // { etn, name }
let wiSuchLauf = 0;

function wiMengeLesen(text) {
  const t = text.trim().toLowerCase().replace(/[\s,_']/g, "");
  const m = t.match(/^(\d+(?:\.\d+)?)([kmb]?)$/);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] ?? 1);
}

function wiWertZeigen(hinweis) {
  const box = el("wiWert");
  const r = wiRechnung();
  const e = WI.eigen;
  if (hinweis) {
    box.innerHTML = '<span class="dim3">' + hinweis + "</span>";
    return;
  }
  if (!e || !r) {
    box.innerHTML = '<span class="dim3">Type an amount like 250000 or 1.5m, or paste a wallet address.</span>';
    return;
  }
  box.innerHTML =
    '<div class="k">' + (e.name ? esc(e.name) + " · " : "") + nf(e.etn) + " ETN with " + esc(r.coin.n) + "'s market cap</div>" +
    '<div class="v num">' + wiPreis(e.etn * r.preis) + "</div>" +
    '<div class="k">worth ' + wiPreis(e.etn * WI.daten.etn.preis) + " today</div>";
}

async function wiMengeEingabe() {
  const feld = el("wiMenge");
  const text = feld.value.trim();
  feld.parentElement.querySelector(".leeren").hidden = !text;
  const lauf = ++wiSuchLauf;
  if (!text) { WI.eigen = null; wiWertZeigen(); wiChipsZeigen(); return; }
  const zahl = wiMengeLesen(text);
  if (zahl != null) { WI.eigen = { etn: zahl, name: null }; wiWertZeigen(); wiChipsZeigen(); return; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
    WI.eigen = null;
    wiWertZeigen(/^0x/i.test(text) ? "A wallet address has 42 characters." : "Type an amount of ETN or a 0x wallet address.");
    return;
  }
  wiWertZeigen("Looking up this wallet…");
  try {
    const d = await hole("/api/search?q=" + encodeURIComponent(text));
    if (lauf !== wiSuchLauf) return; // inzwischen weitergetippt
    if (d.beschaeftigt) { wiWertZeigen("The explorer is busy - try again in a minute."); return; }
    WI.eigen = { etn: Number(d.etn) || 0, name: d.label ?? d.etn_name ?? kurzAdr(text), adresse: text.toLowerCase() };
    wiWertZeigen();
    wiChipsZeigen();
  } catch (err) {
    if (lauf === wiSuchLauf) wiWertZeigen(esc(fehlerText(err)));
  }
}

async function wiChipsZeigen() {
  const box = el("wiChips");
  if (!watchListe().length) {
    box.innerHTML = '<span class="dim3">Tip: wallets you star ⭐ show up here for one-tap checks.</span>';
    return;
  }
  const d = await watchDaten();
  const eintraege = (d?.eintraege ?? []).filter((e) => e.etn > 0).slice(0, 8);
  if (!eintraege.length) { box.innerHTML = ""; return; }
  box.innerHTML = '<span class="wichipkopf">⭐ Your watchlist</span>' + eintraege.map((e) => {
    const name = e.label ?? e.etn_name ?? kurzAdr(e.address);
    const an = WI.eigen && WI.eigen.adresse === e.address;
    return '<button type="button" class="wichip' + (an ? " on" : "") + '" data-adr="' + esc(e.address) +
      '" data-etn="' + e.etn + '" data-name="' + esc(name) + '">' + esc(name) +
      ' <b class="num">' + kurz(e.etn) + "</b></button>";
  }).join("");
}

el("wiMenge").addEventListener("input", () => {
  clearTimeout(wiMengeEingabe.t);
  // Adressen erst abfragen, wenn sie fertig getippt sind - Zahlen sofort.
  wiMengeEingabe.t = setTimeout(wiMengeEingabe, wiMengeLesen(el("wiMenge").value) != null ? 0 : 350);
});
el("wiMenge").parentElement.querySelector(".leeren").addEventListener("click", () => {
  el("wiMenge").value = "";
  wiMengeEingabe();
  el("wiMenge").focus();
});
el("wiChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-adr]");
  if (!b) return;
  el("wiMenge").value = b.dataset.adr;
  el("wiMenge").parentElement.querySelector(".leeren").hidden = false;
  ++wiSuchLauf;
  WI.eigen = { etn: Number(b.dataset.etn), name: b.dataset.name, adresse: b.dataset.adr };
  wiWertZeigen();
  wiChipsZeigen();
});

// ---------- Groesste Migrationen ----------
// "holds today" ist bewusst vorsichtig formuliert: ein Strich heisst nicht
// "leer", sondern "heute nicht unter den erfassten Wallets". Beides sieht in
// der Datenbank gleich aus, und das eine als das andere auszugeben waere
// eine Behauptung ueber fremdes Geld.
const bzZeile = (r, platz, zusatz) =>
  '<a class="bzrow" href="' + EXPLORER + r.address + '" target="_blank" rel="noopener">' +
  '<span class="pos">' + platz + "</span>" +
  '<span class="wer"><span class="adr">' +
    (r.label ? esc(r.label) : kurzAdr(r.checksum_hash ?? r.address)) + "</span>" +
    '<span class="meta">' + zusatz + "</span></span>" +
  '<span class="betrag"><span class="b">' + kurz(r.etn) + " ETN</span>" +
    '<span class="h">' +
    (r.bestand_jetzt != null
      ? "holds " + kurz(r.bestand_jetzt) + " today"
      : "not tracked today") +
    "</span></span></a>";

// Erst die Top 10, jeder Klick auf "Show more" haengt 25 an. Alle knapp 2.000
// auf einmal waeren eine Seite, die niemand bis unten liest.
const BZ = { jahr: "all", zeilen: [], abruf: 0 };
const BZ_ERSTE = 10, BZ_MEHR = 25;

async function ladeMigrationen(mehr = false) {
  const nr = ++BZ.abruf;
  const knopf = el("bzMehr");
  // Beim Jahreswechsel verschwindet der Knopf, bis die neue Liste steht -
  // sonst haengte ein schneller Klick das alte Jahr an das neue.
  if (mehr) knopf.disabled = true;
  else knopf.hidden = true;
  const offset = mehr ? BZ.zeilen.length : 0;
  let d;
  try {
    d = await hole("/api/migrationen?period=" + BZ.jahr + "&offset=" + offset +
      "&limit=" + (mehr ? BZ_MEHR : BZ_ERSTE));
  } catch (e) {
    if (nr !== BZ.abruf) return;
    knopf.disabled = false;
    if (!mehr) {
      el("bzTransfers").className = "empty";
      el("bzTransfers").textContent = fehlerText(e);
    }
    return;
  }
  if (nr !== BZ.abruf) return;
  BZ.zeilen = mehr ? BZ.zeilen.concat(d.eintraege) : d.eintraege;

  periodTabs(el("bzJahre"), BZ.jahr, (k) => {
    BZ.jahr = k;
    ladeMigrationen();
  }, [{ k: "all", t: "All" }, ...d.jahre.map((j) => ({ k: j, t: j }))]);

  const liste = el("bzTransfers");
  liste.className = BZ.zeilen.length ? "" : "empty";
  liste.innerHTML = BZ.zeilen.length
    ? BZ.zeilen.map((r, i) => bzZeile(r, i + 1,
        new Date(r.tag).toLocaleDateString(LOC, { day: "2-digit", month: "short", year: "numeric" }) +
        (r.teile > 1 ? " · in " + r.teile + " transfers" : ""))).join("")
    : "No single migration above " + kurz(d.mindestbetrag) + " ETN" +
      (BZ.jahr === "all" ? "" : " in " + BZ.jahr) + ".";

  const rest = d.gesamt - BZ.zeilen.length;
  knopf.hidden = rest <= 0;
  knopf.disabled = false;
  knopf.textContent = "Show " + Math.min(BZ_MEHR, rest) + " more · " + nf(rest) + " left";
}
el("bzMehr").onclick = () => ladeMigrationen(true);

async function ladeBilanz() {
  let d;
  try {
    d = await hole("/api/bilanz");
  } catch (e) {
    el("bzTransfers").textContent = "Error: " + e.message;
    return;
  }

  const stich = new Date(d.stichtag + "T00:00:00Z");
  const stichText = stich.toLocaleDateString(LOC, { day: "2-digit", month: "long", year: "numeric" });
  const vl = d.verloren ?? {};
  const e30 = d.endspurt ?? {};

  // Vor dem Stichtag bleibt der Kopf, wie ladeOverview() ihn geschrieben hat:
  // Restmenge, Countdown, Tempo. Danach ist das alles beantwortet, und derselbe
  // Platz traegt das Ergebnis.
  if (d.vorbei) {
    el("migIcon").textContent = "🏁";
    el("migLabel").textContent = "Migration closed";
    el("deadlinePill").textContent = "Closed " +
      stich.toLocaleDateString(LOC, { day: "2-digit", month: "short", year: "numeric" });
    el("bridgeEtn").innerHTML = kurz(vl.etn) +
      ' <span style="font-size:.4em;color:var(--tx2);font-weight:500">ETN lost for good</span>';
    el("bridgeSub").innerHTML =
      "<b>" + nf((vl.anteil_supply ?? 0) * 100, 1) + "%</b> of every ETN there has ever been " +
      "never crossed the bridge - held by people who did not make the move in time";

    // Countdown und noetiges Tempo sind gegenstandslos, sobald der Termin
    // vorbei ist. An ihrer Stelle steht, was die Frist gekostet hat.
    el("migStats").innerHTML =
      '<div class="fact"><div class="k">Value at that price</div><div class="v num">' +
        (vl.wert_usd != null ? "$" + kurz(vl.wert_usd) : "—") + "</div></div>" +
      '<div class="fact"><div class="k">Last 30 d before close</div><div class="v num">' +
        (e30.letzte_30 != null ? kurz(e30.letzte_30) : "—") + "</div></div>" +
      '<div class="fact"><div class="k">The 30 d before that</div><div class="v num">' +
        (e30.davor_30 != null ? kurz(e30.davor_30) : "—") + "</div></div>" +
      '<div class="fact"><div class="k">Made it across</div><div class="v num up">' +
        kurz(d.heute?.zirkulierend ?? d.punkte?.T0?.zirkulierend) + "</div></div>";

    // Die Prognosekarte sagt voraus, was laengst feststeht.
    const burn = document.querySelector(".burncard")?.closest("section");
    if (burn) burn.hidden = true;

    // Auch der Reiter heisst dann anders - "Migration" beschreibt ab hier
    // nichts mehr, was noch laeuft.
    const knopf = document.querySelector('#nav [data-p="migration"]');
    if (knopf) knopf.innerHTML = '<span class="ic">🏁</span>Aftermath';
  }

  // --- Vergleichstabelle ---
  const quelle = { ...d.punkte, heute: d.heute };
  // Solange kein einziger Marker steht - also bis zum ersten faelligen, dem
  // 03.11.2026 - haette die Tabelle genau eine gefuellte Spalte. Eine Tabelle
  // mit einer Spalte vergleicht nichts.
  const box = el("bzTabBox");
  if (box) box.hidden = !Object.keys(d.punkte ?? {}).length;
  const spalten = BILANZ_SPALTEN.filter(([k]) => quelle[k] || k === "T0" || k === "heute");
  const kopf =
    "<thead><tr><th></th>" +
    spalten.map(([k, t]) => {
      const q = quelle[k];
      const kl = k === "T0" ? " class=\"stich\"" : k === "heute" ? " class=\"jetzt\"" : "";
      return "<th" + kl + ">" + t +
        (q?.tag ? '<div style="font-weight:400;letter-spacing:0;text-transform:none;' +
          'font-size:10px;margin-top:2px">' + new Date(q.tag).toLocaleDateString(LOC) + "</div>" : "") +
        "</th>";
    }).join("") +
    "</tr></thead>";

  const koerper = BILANZ_ZEILEN.map(([titel, feld, form]) =>
    "<tr><th>" + titel + "</th>" +
    spalten.map(([k]) => {
      const q = quelle[k];
      const v = q?.[feld];
      const kl = k === "T0" ? "stich" : k === "heute" ? "jetzt" : "";
      if (v == null || !isFinite(v)) {
        return '<td class="' + kl + ' offen">—</td>';
      }
      return '<td class="' + kl + '">' + form(v, q) + "</td>";
    }).join("") +
    "</tr>"
  ).join("");

  el("bzTab").innerHTML = kopf + "<tbody>" + koerper + "</tbody>";

  // --- Listen ---
  el("bzTransfersNote").textContent = d.transfers_ab
    ? d.transfers_vollstaendig
      ? "All migrations since " +
        new Date(d.transfers_ab).toLocaleDateString(LOC, { month: "short", day: "numeric", year: "numeric" }) + "."
      : "Checked back to " + new Date(d.transfers_ab).toLocaleDateString(LOC) +
        " so far - the scan works further back with every run, so this ranking can still change."
    : "";

  // --- Wallets, die es vorher nicht gab ---
  const neu = d.neue_wallets;
  if (d.vorbei && neu?.anzahl) {
    el("bzNeuBox").hidden = false;
    el("bzNeu").className = "";
    el("bzNeu").innerHTML =
      '<div class="bfacts"><div><div class="k">Wallets</div><div class="v num">' +
      nf(neu.anzahl) + "</div></div>" +
      '<div><div class="k">They hold</div><div class="v num">' + kurz(neu.etn) +
      " ETN</div></div></div>";
  }
}

const TIERFARBEN = {
  humpback: "#a78bfa", whale: "#5b9cff", shark: "#22d3a7", dolphin: "#4ade80",
  fish: "#fbbf24", octopus: "#fb923c", crab: "#f97316", shrimp: "#f4635e",
  // Faelt bewusst zu Grau aus: ab hier zaehlt nur noch die woechentliche
  // Zaehlung, nicht der 6h-Snapshot - die Farbe soll das mit andeuten.
  plankton: "#94a3b8", microbe: "#64748b", dust: "#475569",
};

/**
 * Tier-Liste.
 *
 * Der Balken zeigt bewusst den SUPPLY-ANTEIL, nicht die Wallet-Zahl. Ein Balken
 * nach Anzahl waere nutzlos: Plankton stellt 99,6 % aller Wallets, alles andere
 * waere ein unsichtbarer Strich. Der Supply-Anteil dreht das Bild um und ist die
 * eigentliche Aussage — wenige Wallets halten fast alles.
 */
/**
 * Veraenderung der Wallet-Zahl gegenueber vor einer Woche. Fehlt der
 * Vergleichswert - erste Woche, noch keine zweite Zaehlung -, steht nichts da
 * statt einer erfundenen Zahl. Der Hinweis nennt, wogegen verglichen wurde.
 */
function tierAenderung(t) {
  const p = t.aenderung_7d;
  if (p == null || !isFinite(p)) return "";
  const gerundet = Math.abs(p) < 10 ? Math.round(p * 10) / 10 : Math.round(p);
  const klasse = gerundet > 0 ? "up" : gerundet < 0 ? "down" : "dim3";
  const text = gerundet === 0 ? "0%" : (gerundet > 0 ? "↑ +" : "↓ ") + nf(gerundet, Math.abs(gerundet) < 10 ? 1 : 0) + "%";
  const titel = "7 days: " + nf(t.anzahl_vorher) + " → " + nf(t.anzahl) +
    (t.vergleich_tag ? " (vs " + new Date(t.vergleich_tag).toLocaleDateString(LOC, { month: "short", day: "numeric" }) + ")" : "");
  return '<span class="aend num ' + klasse + '" title="' + esc(titel) + '">' + text + "</span>";
}

function zeichneTiers(tiers, zirkulierend, tierInfo) {
  // Genau eine Stufe (Dust) hat keine eigene ETN-Summe - sie waere nur ueber
  // eine Zaehlung bis auf 0 ETN zu bekommen, was niemand braucht. Ihr Anteil
  // ergibt sich stattdessen als Rest: zirkulierend minus allem, wofuer eine
  // echte Summe vorliegt.
  const etnBekannt = tiers.filter((t) => t.etn != null).reduce((s, t) => s + t.etn, 0);
  // Gegen die Chain-Gesamtzahl rechnen, NICHT gegen die Summe der sichtbaren
  // Stufen: vor dem ersten Census-Lauf waeren Crab..Dust null, und "% of
  // wallets" wuerde faelschlich nur die oberen ~2.000 Wallets als Grundgesamtheit
  // nehmen - Octopus zeigte dann "44,7%" statt der tatsaechlichen ~0,04%.
  const walletsGesamt = tierInfo?.total_addresses ||
    tiers.reduce((s, t) => s + (t.anzahl || 0), 0) || 1;

  el("tiers").innerHTML = tiers.map((t) => {
    const nochNichtGezaehlt = t.anzahl == null;
    const etn = t.etn != null ? t.etn : Math.max(0, zirkulierend - etnBekannt);
    const supplyAnteil = zirkulierend ? (etn / zirkulierend) * 100 : 0;
    const walletAnteil = ((t.anzahl || 0) / walletsGesamt) * 100;
    const f = TIERFARBEN[t.key] ?? "#64748b";

    // Reihenfolge wichtig: die unterste Stufe hat zwar eine Obergrenze, aber
    // keine sinnvolle Untergrenze — "0 – 100K" liest sich falsch, "< 100K" nicht.
    const bereich =
      t.min === 0 ? "< " + kurz(t.max) + " ETN"
      : t.max ? kurz(t.min) + " - " + kurz(t.max) + " ETN"
      : "≥ " + kurz(t.min) + " ETN";

    if (nochNichtGezaehlt) {
      return '<div class="tierrow" style="opacity:.55">' +
        '<div class="e">' + t.emoji + "</div>" +
        '<div class="nm"><b style="color:' + f + '">' + esc(t.name) + "</b>" +
        "<span>" + bereich + "</span></div>" +
        '<div class="bars"><div class="barlbl">Monthly census pending&hellip;</div></div>' +
        '<div class="cnt"><b style="color:var(--tx3)">&mdash;</b>' +
        "<span>not yet counted</span></div></div>";
    }

    return '<div class="tierrow">' +
      '<div class="e">' + t.emoji + "</div>" +
      '<div class="nm"><b style="color:' + f + '">' + esc(t.name) + "</b>" +
      "<span>" + bereich + (t.census ? " · weekly" : "") + "</span></div>" +
      '<div class="bars"><div class="bar"><i style="width:' +
        Math.max(supplyAnteil, supplyAnteil > 0 ? 1.5 : 0).toFixed(1) +
        '%;background:' + f + '"></i></div>' +
      '<div class="barlbl">' + nf(supplyAnteil, 1) + "% of circulating supply</div></div>" +
      '<div class="cnt"><b style="color:' + f + '">' + nf(t.anzahl) + "</b>" +
      // "0.00 %" sah bei den obersten Stufen kaputt aus - es sind nur sehr wenige.
      "<span>" + (walletAnteil > 0 && walletAnteil < 0.01 ? "<0.01" : nf(walletAnteil, walletAnteil < 1 ? 2 : 1)) +
        "% of wallets</span>" +
      tierAenderung(t) + "</div></div>";
  }).join("");

  const note = el("tiersNote");
  if (note) {
    note.textContent = tierInfo?.census_vorhanden
      ? "Humpback–Octopus updated every 30 min · Crab–Dust from the weekly census (" +
        new Date(tierInfo.census_stand).toLocaleDateString(LOC) + ")"
      : "Humpback–Octopus updated every 30 min · Crab–Dust need the first census to run (weekly, or via the button below)";
  }
}

// ---------- Movers ----------
/**
 * Hat die Bewegung auch Plaetze gekostet?
 *
 * Leer, solange es fuer den Zeitraum keine Rang-Historie gibt - die
 * Aufzeichnung beginnt erst, und fuer 90 Tage zurueck gibt es sie noch lange
 * nicht. Lieber nichts anzeigen als eine erfundene Zahl.
 */
function rangMarke(e) {
  const rd = e.rang_delta;
  if (rd == null || rd === 0) return "";
  return ' <span class="rk ' + (rd > 0 ? "up" : "down") + '">' +
    (rd > 0 ? "▲" : "▼") + Math.abs(rd) + "</span>";
}

function zeileMover(e) {
  const d = e.delta_etn;
  const klasse = d > 0 ? "up" : d < 0 ? "down" : "dim3";
  const betrag = d == null ? "—" : d === 0 ? "±0" : kurz(d, true);
  return '<a class="mv" href="' + EXPLORER + e.address + '" target="_blank" rel="noopener">' +
    '<div class="em">' + e.tier_emoji + "</div>" +
    '<div class="id"><b>' + esc(e.anzeige ?? kurzAdr(e.address)) + "</b>" +
    // Vorher UND nachher. Bisher stand hier nur der heutige Bestand - was das
    // Wallet vor der Bewegung hatte, musste man sich aus Betrag und Prozent
    // selbst zusammenrechnen.
    "<span>rank " + (e.rank_pos ?? "—") + rangMarke(e) + " · " +
      (d == null ? kurz(e.etn) : kurz(e.etn - d) + " → " + kurz(e.etn)) + " ETN</span></div>" +
    '<div class="val"><b class="num ' + klasse + '">' + betrag + "</b>" +
    '<span class="num">' + (d == null ? "" : pctSafe(e.delta_pct, e.etn - d)) + "</span></div></a>";
}
let letzterMoverZeitraum = "7d";

/* ---------- Merkliste -----------------------------------------------------
 *
 * Liegt ausschliesslich im Browser des Besuchers. Kein Konto, kein Server,
 * keine geschriebene Datenbankzeile - und damit auch nichts, was auf ein
 * Tageslimit anrechnet oder ueber Geraete hinweg abgeglichen werden muesste.
 * Der Preis dafuer: die Liste gilt pro Browser. Das ist fuer ein paar
 * beobachtete Wallets der richtige Tausch.
 *
 * Jeder Zugriff ist abgesichert: in einem privaten Fenster oder bei
 * blockierten Seitendaten wirft localStorage, und daran soll nicht die
 * ganze Seite haengen.
 */
const WATCH_KEY = "etnr_merkliste";

function watchListe() {
  try {
    const roh = JSON.parse(localStorage.getItem(WATCH_KEY) ?? "[]");
    return Array.isArray(roh) ? roh.filter((a) => /^0x[0-9a-f]{40}$/.test(a)) : [];
  } catch {
    return [];
  }
}

function watchSpeichern(liste) {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(liste.slice(0, 60)));
  } catch {
    /* privates Fenster o.ae. - die Liste gilt dann nur fuer diese Sitzung */
  }
}

const watchHat = (adr) => watchListe().includes(String(adr).toLowerCase());

function watchUmschalten(adr) {
  const a = String(adr).toLowerCase();
  const liste = watchListe();
  const i = liste.indexOf(a);
  if (i >= 0) liste.splice(i, 1);
  else liste.push(a);
  watchSpeichern(liste);
  document.querySelectorAll('.star[data-addr="' + a + '"]').forEach((b) => {
    const drin = i < 0;
    b.classList.toggle("on", drin);
    b.textContent = drin ? "★" : "☆";
    b.title = drin ? "Remove from watchlist" : "Add to watchlist";
  });
  watchAbfrage = null;
  ladeWatchlist();
  return i < 0;
}

/** Der Stern zum Anklicken - ueberall dieselbe Form. */
function watchStern(adr) {
  const a = String(adr).toLowerCase();
  const drin = watchHat(a);
  return '<button class="star' + (drin ? " on" : "") + '" data-addr="' + a +
    '" title="' + (drin ? "Remove from" : "Add to") + ' watchlist">' +
    (drin ? "★" : "☆") + "</button>";
}

document.addEventListener("click", (e) => {
  const b = e.target.closest(".star, [data-watchbtn]");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const adr = b.dataset.addr ?? b.dataset.watchbtn;
  const drin = watchUmschalten(adr);
  document.querySelectorAll('[data-watchbtn="' + adr + '"]').forEach((k) => {
    k.classList.toggle("on", drin);
    k.textContent = drin ? "★ Watching" : "☆ Watch this wallet";
  });
});

/* Die Merkliste erscheint an drei Stellen: ausfuehrlich auf der
 * Activity-Seite, als anklickbare Marken unter der Wallet-Suche der
 * Uebersicht und ueber der Suche auf der Investigate-Seite. Eine Abfrage
 * fuer alle drei - dieselbe Liste zweimal zu holen waere Unfug.
 */
let watchAbfrage = null;

function watchDaten() {
  const liste = watchListe();
  const signatur = liste.join(",") + "|" + letzterMoverZeitraum;
  if (!watchAbfrage || watchAbfrage.signatur !== signatur) {
    watchAbfrage = {
      signatur,
      p: liste.length
        ? hole("/api/watchlist?period=" + letzterMoverZeitraum + "&addrs=" + liste.join(","))
            .catch(() => null)
        : Promise.resolve({ eintraege: [], fehlend: [] }),
    };
  }
  return watchAbfrage.p;
}

function zeichneWatchChips(d) {
  const html = d?.eintraege?.length
    ? '<span class="lbl">⭐ Watchlist</span>' +
      d.eintraege
        .map(
          (e) =>
            '<button class="wchip" data-watch-go="' + e.address + '">' +
            e.tier_emoji + " <b>" + esc(e.anzeige ?? kurzAdr(e.address)) + "</b>" +
            '<span class="num">' + kurz(e.etn) + "</span></button>"
        )
        .join("")
    : "";
  document.querySelectorAll(".watchchips").forEach((box) => {
    box.innerHTML = html;
    box.style.display = html ? "" : "none";
  });
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-watch-go]");
  if (b) investigateAddress(b.dataset.watchGo);
});

/* ---------- Notizen zu Wallets --------------------------------------------
 *
 * Liegen wie die Merkliste nur im Browser, haengen aber NICHT an ihr: jede
 * Wallet kann eine Notiz tragen - im Leaderboard ueber den Stift, auf der
 * Wallet-Seite direkt unter der Adresse, in der Merkliste wie bisher. Wer ein
 * Wallet beobachtet, weiss nach zwei Wochen nicht mehr, warum; und wer eines
 * nur einmal auffaellig fand, will das nicht erst merken muessen.
 */
const NOTIZ_KEY = "etnr_notizen";

function notizen() {
  try {
    const o = JSON.parse(localStorage.getItem(NOTIZ_KEY) ?? "{}");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function notizSetzen(adr, text) {
  const alle = notizen();
  const t = String(text ?? "").trim().slice(0, 140);
  if (t) alle[adr] = t;
  else delete alle[adr];
  try {
    localStorage.setItem(NOTIZ_KEY, JSON.stringify(alle));
  } catch {
    /* privates Fenster - gilt dann nur fuer diese Sitzung */
  }
}

/**
 * Die Notizzeile einer Wallet. Ohne Notiz gibt es sie nur dort, wo zum
 * Schreiben eingeladen wird (Merkliste, Wallet-Seite) - im Leaderboard waere
 * eine leere Zeile unter jeder Wallet nur Unruhe.
 */
function notizBox(adr, einladung) {
  const a = String(adr).toLowerCase();
  const n = notizen()[a];
  if (!n && !einladung) return "";
  return '<div class="wlnote' + (n ? "" : " leer") + '" data-notiz="' + a + '"' +
    (einladung ? ' data-einladung="' + esc(einladung) + '"' : "") + ">" + esc(n ?? einladung) + "</div>";
}

function notizStift(adr) {
  const a = String(adr).toLowerCase();
  const n = notizen()[a];
  return '<button class="notizstift' + (n ? " on" : "") + '" data-notiz-stift="' + a +
    '" title="' + esc(n ?? "Add a note") + '">📝</button>';
}

/** Nach dem Speichern jede Stelle nachziehen, an der die Wallet gerade steht. */
function notizUeberall(adr) {
  const n = notizen()[adr];
  document.querySelectorAll('[data-notiz="' + adr + '"]').forEach((box) => {
    const einladung = box.dataset.einladung;
    if (!n && !einladung) return box.remove();
    box.className = "wlnote" + (n ? "" : " leer");
    box.textContent = n ?? einladung;
  });
  document.querySelectorAll('[data-notiz-stift="' + adr + '"]').forEach((s) => {
    s.classList.toggle("on", !!n);
    s.title = n ?? "Add a note";
  });
}

/* ---------- Was hat sich seit dem letzten Besuch getan? -------------------
 *
 * Der Vergleich laeuft ueber einen eigenen Staendestand im Browser: bei jedem
 * Besuch werden die Bestaende der gemerkten Wallets gemerkt, beim naechsten
 * Mal dagegen gerechnet. Das ist exakt (kein Tagesraster) und braucht weder
 * Konto noch eine Zeile auf dem Server.
 *
 * Der Stand rollt erst weiter, wenn wirklich Zeit vergangen ist - sonst
 * loescht ein Neuladen der Seite die Information, die gerade angezeigt wird.
 */
const BESUCH_KEY = "etnr_besuch";
const BESUCH_PAUSE_MS = 30 * 60000;

let besuchErgebnis; // undefined = in diesem Seitenaufruf noch nicht gerechnet

function besuchVergleich(eintraege) {
  // ladeWatchlist() laeuft pro Seitenaufruf mehrfach (Uebersicht, Investigate,
  // Activity, nach jedem Stern). Ohne diese Sperre wuerde der erste Aufruf den
  // Stand weiterrollen und jeder weitere haette nichts mehr zu vergleichen.
  if (besuchErgebnis !== undefined) return besuchErgebnis;
  let alt = null;
  try {
    alt = JSON.parse(localStorage.getItem(BESUCH_KEY) ?? "null");
  } catch {
    alt = null;
  }
  const jetzt = Date.now();
  const stand = Object.fromEntries(eintraege.map((e) => [e.address, e.etn]));

  const schreiben = (basisZeit) => {
    try {
      localStorage.setItem(BESUCH_KEY, JSON.stringify({ basisZeit, stand }));
    } catch {
      /* egal */
    }
  };

  if (!alt?.stand) {
    schreiben(jetzt);
    besuchErgebnis = null; // erster Besuch - es gibt noch nichts zu vergleichen
    return besuchErgebnis;
  }

  const diffs = {};
  for (const e of eintraege) {
    const vorher = alt.stand[e.address];
    if (vorher != null && Math.abs(e.etn - vorher) > 0.000001) diffs[e.address] = e.etn - vorher;
  }

  // Weit genug weg gewesen: der Stand rollt weiter, angezeigt wird der alte
  // Vergleich. Innerhalb der halben Stunde bleibt alles stehen, damit ein
  // Neuladen dieselbe Auskunft gibt.
  if (jetzt - (alt.basisZeit ?? 0) >= BESUCH_PAUSE_MS) schreiben(jetzt);

  besuchErgebnis = { seit: alt.basisZeit, diffs };
  return besuchErgebnis;
}

/** Eine Zeile der Merkliste: wie eine Bewegungszeile, aber mit Notiz. */
function zeileMerkliste(e, vergleich) {
  const d = e.delta_etn;
  const klasse = d > 0 ? "up" : d < 0 ? "down" : "dim3";
  const betrag = d == null ? "—" : d === 0 ? "±0" : kurz(d, true);
  const seit = vergleich?.diffs?.[e.address];

  return '<div class="wlrow">' +
    '<div class="em">' + e.tier_emoji + "</div>" +
    '<div class="id">' +
      '<div class="name">' +
        '<a href="' + EXPLORER + e.address + '" target="_blank" rel="noopener"><b>' +
        esc(e.anzeige ?? kurzAdr(e.address)) + "</b></a>" +
        watchStern(e.address) +
        (seit != null
          ? '<span class="seitbadge">' + kurz(seit, true) + " since your last visit</span>"
          : "") +
      "</div>" +
      '<div class="sub">rank ' + (e.rank_pos ?? "—") + " · " +
        (d == null ? kurz(e.etn) : kurz(e.etn - d) + " → " + kurz(e.etn)) + " ETN</div>" +
      notizBox(e.address, "+ add a note - why are you watching this one?") +
    "</div>" +
    '<div class="val"><b class="num ' + klasse + '">' + betrag + "</b>" +
      '<span class="num">' + (d == null ? "" : pctSafe(e.delta_pct, e.etn - d)) + "</span></div>" +
    "</div>";
}

// Notiz anklicken -> Eingabefeld. Enter oder Verlassen speichert, Escape
// verwirft. Nur einmal abschliessen: das Ersetzen des Felds loest selbst noch
// ein Verlassen aus - vorher speicherte dadurch auch Escape.
function notizBearbeiten(box) {
  if (box.querySelector("input")) return;
  const adr = box.dataset.notiz;
  box.classList.remove("leer");
  box.innerHTML = '<input type="text" maxlength="140" placeholder="e.g. suspected exchange hot wallet">';
  const feld = box.querySelector("input");
  feld.value = notizen()[adr] ?? "";
  feld.focus();
  feld.select();
  let erledigt = false;
  const fertig = (speichern) => {
    if (erledigt) return;
    erledigt = true;
    if (speichern) notizSetzen(adr, feld.value);
    notizUeberall(adr);
  };
  feld.onkeydown = (ev) => {
    if (ev.key === "Enter") fertig(true);
    if (ev.key === "Escape") fertig(false);
  };
  feld.onblur = () => fertig(true);
}

document.addEventListener("click", (e) => {
  const stift = e.target.closest("[data-notiz-stift]");
  if (stift) {
    e.preventDefault();
    e.stopPropagation();
    const adr = stift.dataset.notizStift;
    const zelle = stift.parentElement;
    let box = zelle.querySelector('[data-notiz="' + adr + '"]');
    if (!box) {
      zelle.insertAdjacentHTML("beforeend", '<div class="wlnote leer" data-notiz="' + adr + '"></div>');
      box = zelle.lastElementChild;
    }
    return notizBearbeiten(box);
  }
  const box = e.target.closest("[data-notiz]");
  if (box) notizBearbeiten(box);
});

/* ---------- Was ist mit den gemerkten Wallets passiert? --------------------
 *
 * Dasselbe Versprechen wie das Willkommens-Panel: einmal lesen, wegklicken,
 * weg. Es erscheint erst wieder, wenn es wirklich etwas Neues gibt - die
 * Quittung merkt sich den Vergleichsstand, gegen den gerechnet wurde, nicht
 * bloss ein "schon gesehen".
 *
 * Nie gleichzeitig mit dem Willkommens-Panel: wer zum ersten Mal hier ist,
 * hat noch keine Merkliste, und zwei Panels uebereinander waeren eine Wand.
 */
const NEWS_KEY = "etnr_news_quittiert";

function zeichneNews(eintraege, vergleich) {
  const panel = el("newsPanel");
  const bewegt = vergleich
    ? Object.entries(vergleich.diffs).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    : [];

  let quittiert = null;
  try {
    quittiert = localStorage.getItem(NEWS_KEY);
  } catch {
    /* egal */
  }

  if (!bewegt.length || !el("welcome").hidden || String(vergleich.seit) === quittiert) {
    panel.hidden = true;
    return;
  }

  const nach = new Map(eintraege.map((e) => [e.address, e]));
  const notiz = notizen();
  el("newsSub").textContent =
    bewegt.length + (bewegt.length === 1 ? " wallet" : " wallets") +
    " on your watchlist moved since your last visit " +
    zeitHer(new Date(vergleich.seit).toISOString()) + " ago.";

  el("newsList").innerHTML = bewegt
    .slice(0, 5)
    .map(([adr, diff]) => {
      const e = nach.get(adr) ?? {};
      const n = notiz[adr];
      return '<div class="newsrow">' +
        '<div class="em">' + (e.tier_emoji ?? "👛") + "</div>" +
        '<div class="id"><b>' + esc(e.anzeige ?? kurzAdr(adr)) + "</b>" +
          (n ? '<span class="notiz">' + esc(n) + "</span>" : "") + "</div>" +
        '<div class="val ' + (diff > 0 ? "up" : "down") + '">' + kurz(diff, true) + " ETN</div>" +
        "</div>";
    })
    .join("") +
    (bewegt.length > 5
      ? '<div class="dim3" style="font-size:11.5px;padding-top:8px">and ' +
        (bewegt.length - 5) + " more</div>"
      : "");

  panel.dataset.stand = String(vergleich.seit);
  panel.hidden = false;
}

el("newsClose").onclick = () => {
  el("newsPanel").hidden = true;
  try {
    localStorage.setItem(NEWS_KEY, el("newsPanel").dataset.stand ?? "");
  } catch {
    /* egal */
  }
};

el("newsMehr").onclick = () => zeigeSeite("activity");

async function ladeWatchlist() {
  const wrap = el("watchWrap");
  const liste = watchListe();
  // Der leere Zustand ist die einzige Stelle, an der die Merkliste sich
  // ueberhaupt zeigen kann, solange niemand einen Stern gedrueckt hat.
  // Verstecken hiesse: wer nicht weiss, dass es sie gibt, findet sie nie.
  wrap.style.display = "";
  el("watchClear").style.display = liste.length ? "" : "none";
  el("watchCnt").textContent = liste.length
    ? liste.length + (liste.length === 1 ? " wallet" : " wallets") + " · saved in this browser only"
    : "";
  if (!liste.length) {
    el("newsPanel").hidden = true;
    zeichneWatchChips(null);
    el("watchBody").innerHTML =
      '<div class="watchempty"><span class="gross">☆</span><div>' +
      "Tap the <b>star</b> next to any wallet - in the leaderboard, in the top movers, " +
      "or on its profile - and it shows up here with what it did since your last visit. " +
      "Saved in this browser only." +
      "</div></div>";
    el("watchMiss").style.display = "none";
    return;
  }

  const d = await watchDaten();
  if (!d) {
    el("watchBody").innerHTML = '<div class="empty">Could not load the watchlist right now.</div>';
    return;
  }
  zeichneWatchChips(d);

  const vergleich = d.eintraege.length ? besuchVergleich(d.eintraege) : null;
  zeichneNews(d.eintraege, vergleich);
  const bewegt = vergleich ? Object.keys(vergleich.diffs).length : 0;
  const banner = bewegt
    ? '<div class="seitbanner">👀<div><b>' + bewegt + " of " + d.eintraege.length +
      "</b> watched wallets moved since your last visit " +
      zeitHer(new Date(vergleich.seit).toISOString()) + " ago.</div></div>"
    : "";

  el("watchBody").innerHTML = d.eintraege.length
    ? banner + d.eintraege.map((e) => zeileMerkliste(e, vergleich)).join("")
    : '<div class="empty">None of the saved wallets is in the tracked top 3,000 right now.</div>';

  // Gemerkte Adressen, die gerade nicht in den Top N liegen, wortlos
  // verschwinden zu lassen waere die schlechtere Antwort - sie wurden ja
  // bewusst gemerkt.
  const miss = el("watchMiss");
  if (d.fehlend?.length) {
    miss.style.display = "";
    miss.innerHTML = "Not in the tracked top 3,000 right now: " +
      d.fehlend.map((a) => '<code>' + kurzAdr(a) + "</code>").join(", ");
  } else {
    miss.style.display = "none";
  }
}


async function ladeMovers(p, bust) {
  letzterMoverZeitraum = p;
  el("gainers").innerHTML = el("losers").innerHTML = '<div class="skel" style="height:60px"></div>';
  const d = await hole("/api/movers?period=" + p + "&limit=8", bust);
  el("gainers").innerHTML = d.gewinner.length
    ? d.gewinner.map((e) => zeileMover(e)).join("")
    : '<div class="empty">No inflows in this period</div>';
  el("losers").innerHTML = d.verlierer.length
    ? d.verlierer.map((e) => zeileMover(e)).join("")
    : '<div class="empty">No outflows in this period</div>';

  // Eigener Zeitstempel statt sich nur auf die Kopfzeile zu verlassen: wer
  // direkt auf "Activity" landet, sieht sonst nirgends, wie alt die Zahlen
  // sind - genau das hatte zu der Frage "updated das ueberhaupt?" gefuehrt.
  const asOf = el("activityAsOf");
  asOf.textContent = d.snapshot_taken_at
    ? "Data as of snapshot " + zeitHer(d.snapshot_taken_at) + " ago"
    : "No snapshot yet";
  setSnapTime(d.snapshot_taken_at);
}

// ---------- Leaderboard ----------
const LB = { limit: 50, offset: 0, nurEcht: false, nurDienste: false,
             gesamt: 0, minEtn: null, maxEtn: null };

/**
 * Eine Veraenderungs-Zelle im Leaderboard. "±0" heisst nachweislich
 * unveraendert, "—" unbekannt. Reicht die Historie einer Wallet nicht ueber
 * den ganzen Zeitraum, steht der Wert blass da, und der Hinweis beim
 * Darueberfahren nennt, ab wann gezaehlt ist. Die Prozentangabe steht
 * ebenfalls dort - drei Spalten Prozent daneben waeren wieder zu viel.
 */
function deltaZelle(dl, etn, tage) {
  const d = dl?.delta_etn;
  // Ein Ersatzwert zaehlt ab dem ersten bekannten Tag. Deckt der nicht einmal
  // die Haelfte des Zeitraums ab, stuende bei einer Wallet, die heute neu in
  // der Liste ist, "±0" in allen drei Spalten - obwohl sie gerade 514 Mio.
  // bekommen hat. Dann lieber ehrlich "—".
  const heute = new Date().toISOString().slice(0, 10);
  const bekannt = dl?.delta_ab ? Math.round((Date.parse(heute) - Date.parse(dl.delta_ab)) / 86400000) : 0;
  const zuKurz = !dl?.delta_sicher && bekannt < Math.max(1, Math.ceil(tage / 2));
  if (d == null || zuKurz) return '<td class="r num dz dim3">—</td>';
  const ab = dl.delta_sicher || !dl.delta_ab ? "" : " · since " +
    new Date(dl.delta_ab).toLocaleDateString(LOC, { month: "short", day: "numeric", year: "numeric" });
  const klasse = "r num dz " + (d > 0 ? "up" : d < 0 ? "down" : "dim3") + (dl.delta_sicher ? "" : " unsicher");
  const titel = (d === 0 ? "±0%" : pctSafe(dl.delta_pct, etn - d)) + ab;
  return '<td class="' + klasse + '" title="' + esc(titel) + '">' + (d === 0 ? "±0" : kurz(d, true)) + "</td>";
}

async function ladeLeaderboard() {
  el("lbBody").innerHTML = '<tr><td colspan="8"><div class="skel"></div></td></tr>';

  let url = "/api/leaderboard?limit=" + LB.limit + "&offset=" + LB.offset +
    (LB.nurEcht ? "&nur_wallets=1" : "") +
    (LB.nurDienste ? "&nur_dienste=1" : "");
  if (LB.minEtn != null) url += "&min_etn=" + LB.minEtn;
  if (LB.maxEtn != null) url += "&max_etn=" + LB.maxEtn;

  const d = await hole(url);
  LB.gesamt = d.gesamt;

  // Ab Platz ~3.000 kommen die Wallets aus dem woechentlichen Census - eine
  // Trennzeile sagt, ab wo, und wie alt diese Bestaende sind.
  const censusDatum = d.census_stand
    ? new Date(d.census_stand).toLocaleDateString(LOC, { day: "numeric", month: "short" })
    : null;
  const trenner =
    '<tr class="lbtrenner"><td colspan="8"><span>📅 From here on: balances from the weekly census' +
    (censusDatum ? " of <b>" + censusDatum + "</b>" : "") +
    " · open a wallet to see its live balance</span></td></tr>";

  el("lbBody").innerHTML = d.eintraege.map((e, i) => {
    const tags = walletTags(e);
    const censusStart = e.census && (i === 0 ? LB.offset === d.census_ab : !d.eintraege[i - 1].census);
    const stand = e.census && e.stand
      ? new Date(e.stand).toLocaleDateString(LOC, { day: "numeric", month: "short" })
      : null;

    return (censusStart ? trenner : "") + '<tr' + (e.census ? ' class="lbcensus"' : "") + ">" +
      '<td class="num dim3">' + e.platz + "</td>" +
      '<td><a class="addr" href="' + EXPLORER + e.address + '" target="_blank" rel="noopener">' +
        (e.anzeige ? "<b style='color:var(--tx)'>" + esc(e.anzeige) + "</b>" : kurzAdr(e.address)) +
      "</a>" + watchStern(e.address) + notizStift(e.address) + tags + notizBox(e.address) + "</td>" +
      '<td class="tiercell">' + e.tier_emoji + "<span>" + esc(e.tier_name) + "</span></td>" +
      '<td class="r num"><b>' + kurz(e.etn) + "</b></td>" +
      deltaZelle(e.d24h, e.etn, 1) + deltaZelle(e.d7d, e.etn, 7) + deltaZelle(e.d6m, e.etn, 182) +
      (e.census
        ? '<td class="r dim" style="font-size:12px" title="Balance as of ' + esc(stand ?? "") + '">📅 ' + esc(stand ?? "—") + "</td>"
        : '<td class="r dim" style="font-size:12px">' + ruheText(e.ruhetage) + "</td>") +
      "</tr>";
  }).join("");

  const von = Math.min(LB.offset + 1, Math.max(1, LB.gesamt));
  const bis = Math.min(LB.offset + LB.limit, LB.gesamt);
  const seiteAktuell = Math.floor(LB.offset / LB.limit) + 1;
  const seitenGesamt = Math.max(1, Math.ceil(LB.gesamt / LB.limit));
  el("pageInfo").textContent = nf(von) + "–" + nf(bis) + " of " + nf(LB.gesamt) +
    "  (page " + seiteAktuell + "/" + seitenGesamt + ")";
  el("prevPage").disabled = LB.offset === 0;
  el("nextPage").disabled = bis >= LB.gesamt;
  el("pageJump").placeholder = String(seiteAktuell);
}

/**
 * Badges einer Wallet (Exchange, Bridge, Contract, Schlaefer).
 *
 * Bewusst an EINER Stelle, damit Leaderboard und Investigate-Profil nicht
 * auseinanderlaufen - genau das war vorher der Fall: im Leaderboard stand
 * "Unknown Exchange", auf der Profilseite derselben Adresse nichts.
 */
function walletTags(e) {
  let tags = "";
  if (e.label_type === "exchange") tags += '<span class="tag ex">Exchange</span>';
  else if (e.label_type === "bridge") tags += '<span class="tag br">Bridge</span>';
  else if (e.label_type === "service" && e.label_source === "auto") {
    const pct = e.exchange_score != null ? Math.round(e.exchange_score * 100) : null;
    tags += '<span class="tag maybe" title="Auto-detected by behaviour (counterparty fan-out, throughput, 24/7 activity) - not a confirmed identity. Could also be a team/treasury/payout wallet with many recipients. Verify before treating this as a real exchange.">' +
      '🔍 Unknown Exchange' + (pct != null ? " " + pct + "%" : "") + '</span>';
  }
  else if (e.is_contract) tags += '<span class="tag br">Contract</span>';
  if (e.ruhetage != null && e.ruhetage >= 90) tags += '<span class="tag sleep">😴</span>';
  return tags;
}

// ---------- Exchange net-flow ----------
//
// Balkendiagramm um eine Nulllinie: nach oben = ETN wandert AUF die Boersen,
// nach unten = ETN verlaesst sie. Bewusst eine eigene Zeichenfunktion statt
// zeichneChart: dort ist die Aussage der Verlauf einer Kurve, hier die
// Richtung und Groesse einzelner Tage.
const FLOW = { zeitraum: "30d", inklAuto: false, punkte: null };

function zeichneFlowChart(svg, punkte) {
  if (punkte) FLOW.punkte = punkte;
  const daten = FLOW.punkte ?? [];
  const holder = svg.parentElement;
  const tip = el("flowTip");
  if (holder.clientWidth === 0) return; // versteckter Reiter, siehe zeichneChart
  const W = Math.max(320, Math.round(holder.clientWidth));
  const H = W < 640 ? 190 : 240;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.style.height = H + "px";

  if (!daten.length) {
    svg.innerHTML = '<text x="' + W / 2 + '" y="' + H / 2 + '" fill="#5b6b83" font-size="14" ' +
      'text-anchor="middle">no exchange movement in this period</text>';
    return;
  }

  const PT = 14, PB = 30, PL = 74, PR = 12;
  const werte = daten.map((p) => p.netto_etn);
  const max = Math.max(...werte, 0), min = Math.min(...werte, 0);
  const spanne = Math.max(Math.abs(max), Math.abs(min)) || 1;
  const lo = -spanne * 1.1, hi = spanne * 1.1;

  const Y = (v) => PT + ((hi - v) / (hi - lo)) * (H - PT - PB);
  const bw = Math.max(2, Math.min(26, (W - PL - PR) / daten.length - 2));
  const X = (i) => PL + (i + 0.5) * ((W - PL - PR) / daten.length);
  const null_y = Y(0);

  const achse = [hi, hi / 2, 0, lo / 2, lo].map((v) =>
    '<line x1="' + PL + '" y1="' + Y(v) + '" x2="' + (W - PR) + '" y2="' + Y(v) +
    '" stroke="' + (v === 0 ? "#334155" : "#1e293b") + '" stroke-width="1"/>' +
    '<text x="' + (PL - 9) + '" y="' + (Y(v) + 4) + '" fill="#7d8ba3" font-size="11.5" ' +
    'text-anchor="end" font-family="ui-monospace,monospace">' + (v === 0 ? "0" : kurz(v, true)) + "</text>"
  ).join("");

  const balken = daten.map((p, i) => {
    const y = Y(p.netto_etn);
    const hoehe = Math.max(1, Math.abs(y - null_y));
    const farbe = p.netto_etn > 0 ? "#f4635e" : "#22d3a7"; // rein = rot, raus = gruen
    return '<rect x="' + (X(i) - bw / 2).toFixed(1) + '" y="' + Math.min(y, null_y).toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + hoehe.toFixed(1) +
      '" fill="' + farbe + '" opacity=".85" rx="1.5"/>';
  }).join("");

  const marken = Math.max(2, Math.min(5, Math.floor((W - PL - PR) / 130)));
  const datumTexte = Array.from({ length: marken + 1 }, (_, n) => {
    const i = Math.round((n / marken) * (daten.length - 1));
    const anker = n === 0 ? "start" : n === marken ? "end" : "middle";
    return '<text x="' + X(i) + '" y="' + (H - 9) + '" fill="#7d8ba3" font-size="12" ' +
      'text-anchor="' + anker + '" font-family="ui-monospace,monospace">' +
      new Date(daten[i].day).toLocaleDateString(LOC, { month: "short", day: "numeric" }) + "</text>";
  }).join("");

  svg.innerHTML = achse + balken + datumTexte;

  function zeige(ev) {
    const r = holder.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const i = Math.max(0, Math.min(daten.length - 1,
      Math.round(((x - PL) / (W - PL - PR)) * daten.length - 0.5)));
    const p = daten[i];
    tip.innerHTML = '<b class="num" style="color:' + (p.netto_etn > 0 ? "#f4635e" : "#22d3a7") + '">' +
      kurz(p.netto_etn, true) + " ETN</b>" +
      "<span>" + new Date(p.day).toLocaleDateString(LOC, { year: "numeric", month: "short", day: "numeric" }) + "</span>" +
      "<span>" + (p.netto_etn > 0 ? "onto exchanges" : "off exchanges") + "</span>";
    tip.classList.add("on");
    const links = X(i) > W * 0.6;
    tip.style.left = links ? "auto" : X(i) + 14 + "px";
    tip.style.right = links ? W - X(i) + 14 + "px" : "auto";
  }
  const verstecke = () => tip.classList.remove("on");
  holder.onmousemove = zeige;
  holder.onmouseleave = verstecke;
  holder.ontouchmove = (e) => { if (e.touches[0]) zeige(e.touches[0]); };
  holder.ontouchend = verstecke;
}

async function ladeExchangeFlow() {
  const d = await hole("/api/exchange-flow?period=" + FLOW.zeitraum + (FLOW.inklAuto ? "&incl_auto=1" : ""));
  const netto = d.netto_etn;
  const rein = netto > 0;

  el("flowPeriodLbl").textContent = FLOW.zeitraum;
  const n = el("flowNet");
  n.textContent = kurz(netto, true) + " ETN";
  n.className = "v num " + (rein ? "down" : "up");
  el("flowDir").textContent = Math.abs(netto) < 1
    ? "balanced - nothing worth reading into"
    : rein
      ? "net movement ONTO exchanges"
      : "net movement OFF exchanges, into private wallets";
  el("flowIn").textContent = "+" + kurz(d.zufluss_etn);
  el("flowOut").textContent = kurz(d.abfluss_etn);

  zeichneFlowChart(el("flowChart"), d.verlauf);

  el("flowPerEx").innerHTML = d.pro_boerse.map((b) =>
    '<div class="flowex"><div class="nm">' +
      (b.bestaetigt ? "<b>" + esc(b.label) + "</b>" : '<b>' + esc(b.label) + '</b> <span class="tag maybe">detected</span>') +
      ' <span class="dim3" style="font-family:var(--mono);font-size:11.5px">' + kurzAdr(b.address) + "</span></div>" +
      '<div class="val num ' + (b.netto_etn > 0 ? "down" : "up") + '">' + kurz(b.netto_etn, true) + " ETN</div></div>"
  ).join("") || '<div class="empty">No exchange wallets moved in this period</div>';

  el("flowCoverage").textContent =
    d.boersen_gezaehlt + " wallet(s) counted" +
    (d.inkl_auto ? ", including behaviour-detected candidates" : ", confirmed exchanges only") +
    " - exchanges we haven't labelled are not in these numbers.";
  el("flowAuto").textContent = d.inkl_auto ? "− Confirmed exchanges only" : "+ Include detected candidates";
  el("flowAuto").classList.toggle("on", !!d.inkl_auto);
}

beobachte("flowHolder", () => { if (FLOW.punkte) zeichneFlowChart(el("flowChart")); });

// ---------- Sleepers ----------
async function ladeSleepers(bust) {
  const d = await hole("/api/sleepers?limit=12&min_tage=90", bust);
  el("sleepers").innerHTML = d.eintraege.length ? d.eintraege.map((e) =>
    '<a class="mv" href="' + EXPLORER + e.address + '" target="_blank" rel="noopener">' +
    '<div class="em">' + e.tier_emoji + "</div>" +
    '<div class="id"><b>' + esc(e.anzeige ?? kurzAdr(e.address)) + "</b>" +
    "<span>rank " + (e.rank_pos ?? "—") + " · " + e.tier_name + "</span></div>" +
    '<div class="val"><b class="num">' + kurz(e.etn) + "</b>" +
    "<span>" + ruheText(e.ruhetage) + " dormant</span></div></a>"
  ).join("") : '<div class="empty">No sleepers found</div>';
}

// ---------- Events ----------
const EV = {
  gain:         { i: "▲",  f: "#22d3a7", t: "Inflow" },
  loss:         { i: "▼",  f: "#f4635e", t: "Outflow" },
  sleeper_wake: { i: "😴", f: "#fbbf24", t: "Sleeper woke up" },
  drained:      { i: "🚨", f: "#f4635e", t: "Wallet drained" },
  tier_up:      { i: "⬆",  f: "#a78bfa", t: "Tier up" },
  tier_down:    { i: "⬇",  f: "#64748b", t: "Tier down" },
  rank_enter:   { i: "✨", f: "#5b9cff", t: "New in top N" },
  rank_exit:    { i: "👋", f: "#64748b", t: "Left top N" },
};
/**
 * Betrag eines Ereignisses.
 *
 * Bei "New in top N" ist die Zahl der BESTAND des Wallets, keine Bewegung: Es
 * kann seit Jahren unveraendert daliegen und rutscht nur deshalb in die Liste,
 * weil ein anderes darunter herausgefallen ist. Das fruehere "+" davor
 * behauptete einen Zufluss, den es nie gegeben hat - bei einem Tracker, der
 * Wal-Bewegungen meldet, die unangenehmste Sorte Fehler.
 */
function evBetrag(e) {
  if (!e.delta_etn) return "";
  if (e.type === "rank_enter") return " · holds " + kurz(e.delta_etn) + " ETN";
  return " · " + kurz(e.delta_etn, true) + " ETN";
}

/** Die Nebenrollen eines gebuendelten Ereignisses als kleine Marken. */
function nebenrollen(e) {
  const weitere = [...new Set(e.auch ?? [])];
  if (!weitere.length) return "";
  return weitere
    .map((t) => '<span class="evtag">' + (EV[t]?.t ?? t) + "</span>")
    .join("");
}

async function ladeEvents(bust) {
  const d = await hole("/api/events?limit=14&min_severity=25", bust);
  el("events").innerHTML = d.eintraege.length ? d.eintraege.map((e) => {
    const k = EV[e.type] ?? { i: "•", f: "#64748b", t: e.type };
    return '<a class="ev" href="' + EXPLORER + e.address + '" target="_blank" rel="noopener">' +
      '<div class="ic" style="background:' + k.f + '1c;color:' + k.f + '">' + k.i + "</div>" +
      '<div class="tx"><b>' + k.t + evBetrag(e) +
      nebenrollen(e) + "</b>" +
      "<div>" + esc(e.anzeige ?? kurzAdr(e.address)) +
      (e.tier_from ? " · " + e.tier_from + " → " + e.tier_to : "") + "</div></div>" +
      '<div class="when">' + zeitHer(e.detected_at) + "</div></a>";
  }).join("") : '<div class="empty">No events yet - they appear from the second snapshot onwards</div>';
}

// ---------- Cluster guesses (experimental) ----------
async function ladeClusters() {
  el("clusters").innerHTML = '<div class="skel" style="height:120px"></div>';
  const d = await hole("/api/clusters");
  el("clustersNote").textContent = d.stand
    ? "Last computed " + new Date(d.stand).toLocaleString(LOC) +
      " · only among the individually-tracked (fast-tier) wallets"
    : "No analysis has run yet - click \"Run cluster analysis now\" below, " +
      "or wait for the weekly run.";

  if (!d.gruppen.length) {
    el("clusters").innerHTML = '<div class="empty">' +
      (d.stand ? "No shared-funding groups found." : "Nothing computed yet.") + '</div>';
    return;
  }

  el("clusters").innerHTML = d.gruppen.map((g) => {
    const srcNote = g.funding_source_label
      ? '<span class="tag ' + (g.funding_source_type === "exchange" ? "ex" : "br") + '">' +
        esc(g.funding_source_label) + "</span>"
      : g.funding_source_rank
      ? '<span class="tag">rank ' + g.funding_source_rank + " · " + kurz(g.funding_source_etn) + " ETN</span>"
      : "";
    const conf = Math.round(g.durchschnitt_anteil * 100);
    return '<div class="clustergroup">' +
      '<div class="head">' +
      '<div class="src">Funding source <b>' + kurzAdr(g.funding_source) + "</b>" + srcNote + "</div>" +
      '<div class="combo"><b class="num">' + kurz(g.kombiniert_etn) + " ETN</b>" +
      "<span>" + g.mitglieder + " wallets combined</span></div></div>" +
      '<div class="confbar" title="Average share of inbound funds from this source">' +
      '<i style="width:' + conf + '%"></i></div>' +
      g.wallets.map((w) =>
        '<a class="cmember" href="' + EXPLORER + w.address + '" target="_blank" rel="noopener">' +
          '<div class="em">' + tierEmoji(w.tier) + "</div>" +
          '<div class="id">' + (w.anzeige ? "<b>" + esc(w.anzeige) + "</b> " : "") + kurzAdr(w.address) + "</div>" +
          '<div class="val"><b class="num">' + kurz(w.etn) + " ETN</b>" +
          "<span>" + Math.round(w.funding_share * 100) + "% from this source</span></div></a>"
      ).join("") +
      "</div>";
  }).join("");
}
const tierEmoji = (key) => ({
  humpback:"🐋",whale:"🐳",shark:"🦈",dolphin:"🐬",fish:"🐟",octopus:"🐙",
  crab:"🦀",shrimp:"🦐",plankton:"🦠",microbe:"🧫",dust:"💨",
}[key] ?? "•");

// ---------- Investigate (full wallet detail page) ----------
async function ladeWalletDetail(q) {
  el("invTipps").hidden = true;
  const wrap = { head: el("invResultWrap"), chart: el("invChartWrap"), cluster: el("invClusterWrap"), events: el("invEventsWrap"), fluss: el("invFlowWrap") };
  const empty = el("invEmpty");
  Object.values(wrap).forEach((w) => (w.style.display = "none"));
  empty.style.display = "none";
  el("invHead").innerHTML = '<div class="skel" style="height:74px"></div>';
  wrap.head.style.display = "";

  let d;
  try {
    d = await hole("/api/search?q=" + encodeURIComponent(q));
  } catch (e) {
    el("invHead").innerHTML = '<div class="empty">' + esc(fehlerText(e)) + "</div>";
    return;
  }

  // Namenssuche mit mehreren Treffern: Liste zum Auswaehlen statt Detailseite.
  if (d.treffer) {
    wrap.chart.style.display = wrap.cluster.style.display = wrap.events.style.display = wrap.fluss.style.display = "none";
    el("invHead").innerHTML = d.treffer.length
      ? '<div style="font-size:13px;color:var(--tx2);margin-bottom:10px">' + d.treffer.length + ' match(es) - pick one:</div>' +
        d.treffer.map((e) =>
          '<a class="mv" href="javascript:void(0)" data-addr="' + e.address + '">' +
            '<div class="em">' + e.tier_emoji + "</div>" +
            '<div class="id"><b>' + esc(e.anzeige ?? kurzAdr(e.address)) + "</b>" +
            "<span>rank " + (e.rank_pos ?? "—") + " · " + kurz(e.etn) + " ETN</span></div>" +
          "</a>"
        ).join("")
      : '<div class="empty">Nothing found</div>';
    return;
  }

  renderWalletDetail(d);
}

// ---------- Share ("where do I stand") ----------
//
// Privacy-first: die Adresse wird beim Teilen standardmaessig NICHT
// mitgeschickt, nur Tier/Rang/Fortschritt. Ein Toggle blendet sie auf
// Wunsch ein - bewusst kein Default, den man erst abwaehlen muss.
let CUR_WALLET = null;
let ZEIGE_ADRESSE = false;
let TELEGRAM_BOT = null; // Bot-Benutzername aus /api/overview, null = Feature nicht konfiguriert

/**
 * Zwei bewusst UNTERSCHIEDLICHE Texte, nicht derselbe mit weggelassener Adresse:
 *
 *   versteckt -> nur die Stufe. KEIN Rang, keine Adresse. Der Rang allein
 *                waere schon eine Identifizierung - "Rang 137" kann jeder im
 *                Leaderboard nachschlagen, damit waere das Verstecken sinnlos.
 *   sichtbar  -> Adresse, Rang, Stufe und der Weg zur naechsten Stufe.
 */
/**
 * Share-Texte je Stufe.
 *
 * Drei Saetze je Stufe - stolz, witzig, ruhig -, die Person waehlt selbst.
 * Jeder Satz bekommt sein eigenes Bild <stufe>-<ton> in public/assets/share/
 * (Link-Vorschau *-card.jpg, gerahmtes Foto *-square.jpg). Beim Oeffnen ist ein
 * Satz mit Bild zufaellig vorgewaehlt, damit nicht alle einer Stufe denselben
 * Post schicken.
 *
 * Bewusst ohne Kursversprechen und ohne "to the moon": der Text geht unter dem
 * Namen der Person hinaus, und eine Prognose, die sie nie abgegeben hat,
 * gehoert nicht hinein.
 */
const SHARE_SAETZE = {
  humpback: [
    ["proud", "only a handful of us live this deep. The ocean goes quiet when we move."],
    ["funny", "I don't check the price. The price checks on me."],
    ["calm", "deep water, long breath, zero rush."],
  ],
  whale: [
    ["proud", "when I surface, the whole chain feels the wave."],
    ["funny", "relax, I didn't sell. I just rolled over in my sleep."],
    ["calm", "eight figures deep and in no hurry."],
  ],
  shark: [
    ["proud", "calm on the surface, sharp underneath."],
    ["funny", "the whales think they're in charge. Cute."],
    ["calm", "patient. Circling. Never far from the action."],
  ],
  dolphin: [
    ["proud", "smart money swims in pods."],
    ["funny", "not the biggest in the ocean. Definitely having the most fun."],
    ["calm", "quick, clever, and keeping pace with the giants."],
  ],
  fish: [
    ["proud", "seven figures of ETN and still swimming upstream."],
    ["funny", "officially a millionaire. In ETN. Please don't do the conversion."],
    ["calm", "one million reasons to keep swimming."],
  ],
  octopus: [
    ["proud", "eight arms, zero paper hands."],
    ["funny", "eight arms and not one of them can find the sell button."],
    ["calm", "clever, flexible, and holding on with everything I've got."],
  ],
  crab: [
    ["proud", "hard shell, strong grip, not letting go."],
    ["funny", "sideways market? Crabs were literally built for this."],
    ["calm", "sideways is still forward."],
  ],
  shrimp: [
    ["proud", "six figures and punching above my weight."],
    ["funny", "the whales' favourite snack? Not today."],
    ["calm", "small on my own, but the ocean runs on us."],
  ],
  plankton: [
    ["proud", "no plankton, no whales. Simple biology."],
    ["funny", "whales eat plankton? I'd like to see them try."],
    ["calm", "the whole food chain is built on us."],
  ],
  microbe: [
    ["proud", "microscopic, but I'm on the chain."],
    ["funny", "zoom in. No, more. More. There I am."],
    ["calm", "everyone starts somewhere. This is my somewhere."],
  ],
  dust: [
    ["proud", "every whale started as a speck."],
    ["funny", "technically dust. Spiritually a whale."],
    ["calm", "dust today, a story tomorrow."],
  ],
};
// Saetze, deren Bilder schon fertig sind. Muss zu SHARE_BILDER in src/share.js
// passen, sonst zeigt die Link-Vorschau ein fremdes Bild - tests/share.test.mjs
// prueft das.
const SHARE_TON = {
  proud: "😎 Proud", funny: "😂 Funny", calm: "😌 Calm",
  hype: "🔥 Hype", denk: "🤔 What next", napkin: "🧮 Napkin math",
  // Bildwahl beim Wochenrueckblick: gleicher Text, anderes Bild.
  bridge: "🌉 Bridge", whale: "🐳 Whale", busy: "📈 Busy", radar: "📡 Radar",
};
const SHARE_BILDER = new Set([
  "humpback-proud", "humpback-funny", "humpback-calm",
  "whale-proud", "whale-funny", "whale-calm",
  "shark-proud", "shark-funny", "shark-calm",
  "dolphin-proud", "dolphin-funny", "dolphin-calm",
  "fish-proud", "fish-funny", "fish-calm",
  "octopus-proud", "octopus-funny", "octopus-calm",
  "crab-proud", "crab-funny", "crab-calm",
  "shrimp-proud", "shrimp-funny", "shrimp-calm",
  "plankton-proud", "plankton-funny", "plankton-calm",
  "microbe-proud", "microbe-funny", "microbe-calm",
  "dust-proud", "dust-funny", "dust-calm",
]);
let SHARE_WAHL = 0;

// "I'm a Whale", "I'm an Octopus" - Plankton und Dust ohne Artikel.
const mitArtikel = (d) =>
  (d.tier === "plankton" || d.tier === "dust" ? "" : /^[aeiou]/i.test(d.tier_name) ? "an " : "a ") + d.tier_name;
const ichBin = (d) => "I'm " + mitArtikel(d) + " on the Electroneum Smart Chain";

/**
 * Post-Text je Bild und Weg (siehe Share-Dialog):
 *   karte - der Satz steht schon im Bild, im Text nicht nochmal
 *   foto  - der Satz kommt in den Text
 *   text  - Satz im Text
 * mitLink: der Link wird angehaengt (X/Telegram per Adresse) - sonst steht nur
 * die kurze Domain im Text, etwa wenn das Bild als Foto rausgeht.
 * Die Vorschaukarte bringt ihren Aufruf ("What's your tier?") selbst mit, darum
 * bleibt der Text bei karte + Link am kuerzesten.
 */
function buildShareText(d, zeigeAdresse, format = "text", mitLink = true) {
  const s = SHARE_SAETZE[d.tier]?.[SHARE_WAHL];
  const kopf = d.tier_emoji + " " + ichBin(d);
  const satz = format === "karte" || !s ? kopf + "." : kopf + " - " + s[1];
  // Aufbau wie bei allen Posts: Haken, Zahlen zum Ueberfliegen, Schlusszeile.
  const ende = (ruf) => (mitLink ? ruf + " 👇" : ruf + " " + location.host);
  if (!zeigeAdresse) return satz + "\n\n" + ende("What are you? Find your tier on ETN Radar");
  return [satz, "", shareFakten(d).join("\n"), "", ende("Where do you stand? Check yours on ETN Radar")].join("\n");
}

/**
 * Post-Text fuer ein fremdes Wallet ("Someone else's"): dritte Person, die
 * Adresse geht immer mit - man zeigt ja bewusst auf dieses Wallet. Der Satz
 * wird zum Zitat des Wallets, so passen dieselben Bilder, ohne dass der Post
 * behauptet, es sei das eigene. Bei karte steht der Satz schon im Bild.
 */
function fremdText(d, format) {
  const s = SHARE_SAETZE[d.tier]?.[SHARE_WAHL];
  const wer = d.anzeige
    ? d.anzeige + ", " + mitArtikel(d) + " " + d.tier_emoji + ","
    : mitArtikel(d) + " " + d.tier_emoji;
  const zeilen = ["👀 Spotted " + wer + " on the Electroneum Smart Chain.", ""];
  if (d.in_top_n && d.rank_pos) zeilen.push("🏆 Rank #" + nf(d.rank_pos) + " of all ETN holders");
  zeilen.push("💰 Holding " + kurz(d.etn) + " ETN", "🔑 " + d.address);
  if (format !== "karte" && s) zeilen.push("", "Its message: “" + s[1].charAt(0).toUpperCase() + s[1].slice(1) + "”");
  zeilen.push("", "Look this wallet up on ETN Radar 👇");
  return zeilen.join("\n");
}

// Rang, Bestand, naechste Stufe, Adresse - nur wenn die Adresse mitgehen darf.
// Je Zeile ein Emoji: im Feed liest niemand einen Block Fliesstext.
function shareFakten(d) {
  const fakten = [];
  if (d.in_top_n && d.rank_pos) fakten.push("🏆 Rank #" + nf(d.rank_pos) + " of all ETN holders");
  fakten.push("💰 Holding " + kurz(d.etn) + " ETN");
  if (d.bis_naechster_tier != null) {
    // Kein "Only" und kein "I'll make it!": bei Fish -> Dolphin fehlen schnell
    // eine Million, und ein Versprechen gehoert nicht in einen fremden Post.
    fakten.push("🎯 Next stop: " + [d.naechster_tier, TIER_EMOJI[d.naechster_tier]].filter(Boolean).join(" ") +
      " - " + kurz(d.bis_naechster_tier) + " ETN to go");
  } else {
    fakten.push("🏔️ Top tier reached - nowhere left to climb 🎉");
  }
  fakten.push("🔑 " + d.address);
  return fakten;
}

// Nach dem vollen Namen der Stufe, so wie ihn der Server schickt. Vorher stand
// hier "Humpback" statt "Humpback Whale" - wer als Whale teilte, bekam an der
// Stelle des naechsten Emojis eine Luecke.
const TIER_EMOJI = {
  "Humpback Whale": "🐋", Whale: "🐳", Shark: "🦈", Dolphin: "🐬", Fish: "🐟",
  Octopus: "🐙", Crab: "🦀", Shrimp: "🦐", Plankton: "🦠", Microbe: "🧫", Dust: "💨",
};

function shareBlock(addr) {
  const alarm = TELEGRAM_BOT
    ? '<a class="ghost" href="https://t.me/' + TELEGRAM_BOT + '?start=' + addr.slice(2) +
      '" target="_blank" rel="noopener">🔔 Alert me if this wallet wakes up</a>'
    : "";
  const drin = watchHat(addr);
  return '<div class="sharebar">' +
    '<button id="shareOpen">📢 Share</button>' +
    '<button class="watchbtn' + (drin ? " on" : "") + '" data-watchbtn="' +
      String(addr).toLowerCase() + '">' + (drin ? "★ Watching" : "☆ Watch this wallet") + "</button>" +
    alarm +
    "</div>";
}

// ---------- Share-Dialog ----------
// Oben waehlt man Satz und Bild: karte (Bild + Satz), foto (gerahmtes 1:1)
// oder text. Saetze ohne fertiges Bild gehen nur als Text.
//
// Darunter entscheidet das Geraet den Hauptweg, ohne dass jemand waehlen muss:
//   Handy  - "Share" oeffnet das Teilen-Menue des Geraets; Bild und Text landen
//            zusammen in X, Telegram & Co., ganz ohne Link.
//   PC     - X und Telegram lassen eine Webseite kein Bild mitschicken. Die
//            karte geht darum als Link, X/Telegram holen sie als Vorschau.
//            Das foto nicht: eine Vorschaukarte ist immer breit und schnitte das
//            Quadrat ab - also "Save photo" und "Copy text", posten per Hochladen.
// Klein darunter liegen die anderen Wege, falls die Erkennung danebenliegt.
//
// Derselbe Dialog teilt auch fertige Texte, etwa den Wochenrueckblick auf dem
// Chain-Reiter: dann ohne Adress-Schalter, Satz- und Bildwahl.
// SHARE_FREMD = { titel, text, url, bild } oder null fuer den Rang.
let SHARE_FREMD = null;
let SHARE_FORMAT = "karte";
// Wessen Wallet: "fremd" ist vorgewaehlt - wer ein Wallet oeffnet, will meist
// genau dieses zeigen. "mein" spricht in der ersten Person.
let SHARE_WER = "fremd";
let SHARE_FOTO = { schluessel: null, datei: null, laden: null };

const shareBildId = () => {
  if (SHARE_FREMD) return SHARE_FREMD.varianten?.[SHARE_WAHL]?.[2] ?? SHARE_FREMD.bild ?? null;
  const s = SHARE_SAETZE[CUR_WALLET?.tier]?.[SHARE_WAHL];
  const id = s ? CUR_WALLET.tier + "-" + s[0] : null;
  return id && SHARE_BILDER.has(id) ? id : null;
};
const shareBildUrl = (id, art) => location.origin + "/assets/share/" + id + "-" + art + ".jpg";
const bildArt = (format) => (format === "foto" ? "square" : "card");
const aktivesFormat = () => (shareBildId() ? SHARE_FORMAT : "text");
const kannFotoTeilen = () => {
  try { return !!navigator.canShare?.({ files: [new File([""], "x.jpg", { type: "image/jpeg" })] }); } catch { return false; }
};
// Handy = mit dem Finger bedient UND der Browser kann Bilder an Apps geben.
// Manche PC-Browser koennen Letzteres auch, das Teilen-Menue bringt dort aber nichts.
const istHandy = () => {
  try { return matchMedia("(pointer: coarse)").matches && kannFotoTeilen(); } catch { return false; }
};
const hauptWeg = () => (istHandy() && aktivesFormat() !== "text" ? "datei" : "link");

// Link mit dem breiten Bild als Vorschau (src/share.js); ?w= fuer ein fremdes Wallet.
const shareLink = (wallet) => location.origin + "/s/" + shareBildId() + (wallet ? "?w=" + wallet : "");

// Unter jedem Post dieselben Hashtags - der Link bleibt ganz am Ende, dann
// blendet X ihn aus und zeigt nur die Vorschaukarte.
const SHARE_TAGS = "#ETN #Electroneum #ETNRadar #GalacticSL";
function shareInhalt(weg) {
  const i = shareInhaltRoh(weg);
  // Manche Fassungen bringen eigene Hashtags mit und ersetzen die festen (Kurs-Post).
  const tags = SHARE_FREMD?.tags ?? SHARE_TAGS;
  return { text: i.text + "\n\n" + tags, url: i.url };
}

// Was rausgehen wuerde: { text, url }. weg "datei" = Bild als Foto, "link" = per Adresse.
function shareInhaltRoh(weg) {
  const format = aktivesFormat();
  if (SHARE_FREMD) {
    const text = SHARE_FREMD.varianten?.[SHARE_WAHL]?.[1] ?? SHARE_FREMD.text;
    // Als Karte fuehrt der Link ueber /s/<bild>, damit X und Telegram genau
    // dieses Bild als Vorschau zeigen; als Foto geht die Datei selbst raus.
    if (format === "karte" && weg === "link") return { text, url: location.origin + "/s/" + shareBildId() };
    if (format !== "text") return { text, url: "" };
    return { text, url: SHARE_FREMD.url };
  }
  if (SHARE_WER === "fremd") {
    const text = fremdText(CUR_WALLET, format);
    // Die Vorschau fuehrt ueber ?w= direkt zum Wallet statt zur Startseite.
    if (format === "karte" && weg === "link") return { text, url: shareLink(CUR_WALLET.address) };
    return { text, url: location.origin + "/wallet/" + CUR_WALLET.address };
  }
  if (format === "karte" && weg === "link") {
    return { text: buildShareText(CUR_WALLET, ZEIGE_ADRESSE, "karte", true), url: shareLink() };
  }
  if (format !== "text") return { text: buildShareText(CUR_WALLET, ZEIGE_ADRESSE, format, false), url: "" };
  return { text: buildShareText(CUR_WALLET, ZEIGE_ADRESSE, "text", true), url: shareUrl() };
}

// Das Bild schon beim Umschalten laden: das Teilen-Menue muss direkt im Klick
// aufgehen, sonst verweigert es der Browser (vor allem Safari).
function fotoVorladen(id, art) {
  const schluessel = id + "-" + art;
  if (SHARE_FOTO.schluessel === schluessel) return SHARE_FOTO.laden;
  const eintrag = { schluessel, datei: null, laden: null };
  SHARE_FOTO = eintrag;
  eintrag.laden = fetch(shareBildUrl(id, art))
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => { if (b) eintrag.datei = new File([b], "etn-radar-" + schluessel + ".jpg", { type: "image/jpeg" }); })
    .catch(() => {})
    .finally(() => { if (!eintrag.datei) eintrag.schluessel = null; });
  return eintrag.laden;
}

// Text fuer das ⓘ neben der Bildwahl - je Bild und Geraet, weil sich die Wege unterscheiden.
function shareInfoText(format) {
  const handy = istHandy();
  if (format === "karte") {
    return handy
      ? "Image + text: the picture with your line next to it. Share sends it straight into X, Telegram & co. together with the text. \"as link\" posts a link instead, and X or Telegram show this picture as its preview."
      : "Image + text: posts a link. X and Telegram show this picture as the link preview, and a click on it opens ETN Radar.";
  }
  if (format === "foto") {
    return handy
      ? "Photo 1:1: the square picture as a real photo. Share sends it straight into X, Telegram & co. together with the text."
      : "Photo 1:1: the square picture as a real photo. X and Telegram don't take photos from a website, so save the photo, copy the text and upload both in your post. A link can't do this: link previews are always wide and would cut the square.";
  }
  return "Text only: just the text with a link. X and Telegram show the ETN Radar banner as the link preview.";
}

function shareKnoepfe() {
  const format = aktivesFormat();
  const k = (aktion, text, klasse = "") =>
    '<button type="button" class="' + klasse + '" data-aktion="' + aktion + '">' + text + "</button>";
  let gross, klein = [];
  if (istHandy() && (!SHARE_FREMD || format !== "text")) {
    gross = k("teilen", "📤 Share");
    // Als Link nur das breite Bild - ein Quadrat schnitte die Vorschaukarte ab.
    if (format === "karte") klein.push(k("x", "𝕏 as link"), k("tg", "✈️ as link"));
    if (format !== "text") klein.push(k("speichern", "⬇️ Save image"));
    klein.push(k("kopieren", "📋 Copy text"));
  } else if (format === "foto") {
    // Ein echtes Foto nehmen X und Telegram am PC nur per Hochladen an.
    gross = k("speichern", "⬇️ Save photo") + k("kopieren", "📋 Copy text", "ghost");
    klein.push(k("x", "𝕏 Open X"), k("tg", "✈️ Open Telegram"));
  } else {
    gross = k("x", "𝕏&nbsp; Post on X") + k("tg", "✈️ Telegram", "ghost");
    if (format === "karte") klein.push(k("speichern", "⬇️ Save image"));
    klein.push(k("kopieren", "📋 Copy text"));
  }
  el("shareFoot").innerHTML = gross;
  el("shareMehr").innerHTML = klein.join("");
}

// Bildwahl, ⓘ-Text und Vorschaubild - gleich fuer Rang und fertigen Text.
function shareBildZeigen(id, format) {
  el("shareInfoKnopf").dataset.info = shareInfoText(format);
  el("shareFormat").querySelectorAll("button[data-format]").forEach((b) => {
    const an = b.dataset.format === format;
    b.classList.toggle("on", an);
    b.setAttribute("aria-checked", String(an));
    b.disabled = !id && b.dataset.format !== "text";
  });
  const bild = el("shareBild");
  bild.hidden = format === "text";
  bild.classList.toggle("foto", format === "foto");
  if (bild.hidden) return;
  const src = shareBildUrl(id, bildArt(format));
  if (el("shareBildImg").getAttribute("src") !== src) el("shareBildImg").src = src;
  if (istHandy()) fotoVorladen(id, bildArt(format));
}

// Wie X zaehlt: Emoji zaehlen doppelt, alles andere einfach.
const xZeichen = (t) => [...t].length + (t.match(/\p{Extended_Pictographic}/gu) ?? []).length;

function shareVorschau() {
  if (!SHARE_FREMD && !CUR_WALLET) return;
  const inhalt = shareInhalt(hauptWeg());
  el("sharePreview").textContent = inhalt.text + (inhalt.url ? "\n" + inhalt.url : "");
  // X zaehlt jeden Link als 23 Zeichen und Emoji doppelt. Ueber 280 geht der
  // Post nur mit X Premium raus - besser hier sagen als im Absende-Fenster.
  const lang = xZeichen(inhalt.text) + (inhalt.url ? 24 : 0);
  el("shareLaenge").hidden = lang <= 280;
  el("shareLaenge").textContent = lang + " characters - X posts longer than 280 need X Premium. " +
    "Telegram, Discord and copying the text are not affected.";
  shareKnoepfe();

  // Bildwahl und Vorschaubild gibt es fuer beides: fuer den eigenen Rang und
  // fuer einen fertigen Text mit Bild, etwa den Wochenrueckblick.
  const id = shareBildId();
  const format = aktivesFormat();
  if (SHARE_FREMD) el("shareFormat").hidden = !id;
  shareBildZeigen(id, format);
  if (SHARE_FREMD) return;

  const fremd = SHARE_WER === "fremd";
  el("shareTitel").textContent = fremd ? "📢 Share this wallet" : "📢 Share your rank";
  el("shareWer").querySelectorAll("button").forEach((b) => {
    const an = b.dataset.wer === SHARE_WER;
    b.classList.toggle("on", an);
    b.setAttribute("aria-checked", String(an));
  });
  el("shareHideRow").hidden = fremd;

  el("sharePrivacyNote").textContent = fremd
    ? "The address goes out with the post."
    : ZEIGE_ADRESSE
      ? "Your address and rank go out with the post - anyone can look up this wallet's full balance and history."
      : "Only your tier goes out. No address, no rank - nothing that could be traced back to your wallet.";
  el("sharePrivacyNote").style.color = fremd ? "var(--tx2)" : ZEIGE_ADRESSE ? "var(--warn)" : "var(--acc2)";
}
// Der Link verraet die Wallet nur, wenn die Adresse ohnehin mitgeht - sonst
// stuende sie seit den sauberen Pfaden (/wallet/0x...) im geteilten Link.
const shareUrl = () =>
  location.origin + (ZEIGE_ADRESSE && CUR_WALLET ? "/wallet/" + CUR_WALLET.address : "/");

// Die Auswahl oben im Dialog: beim Rang die drei Saetze der Stufe, bei einem
// fertigen Text die mitgegebenen Fassungen (Wochenrueckblick hat eine, der
// What-if-Vergleich drei - je mit eigenem Bild).
const shareVarianten = () =>
  SHARE_FREMD ? SHARE_FREMD.varianten ?? null : SHARE_SAETZE[CUR_WALLET?.tier] ?? null;

function shareTexteZeigen() {
  const saetze = shareVarianten();
  const box = el("shareTexte");
  box.hidden = !saetze;
  if (!saetze) return;
  // Nur die Stimmung als Knopf - der Satz selbst steht im Bild bzw. in der Vorschau darunter.
  box.innerHTML = saetze
    .map((s, i) => '<button type="button" role="radio" aria-checked="' + (i === SHARE_WAHL) +
      '" class="ghost' + (i === SHARE_WAHL ? " on" : "") + '" data-i="' + i + '" title="' + esc(s[1]) + '">' +
      (SHARE_TON[s[0]] ?? esc(s[1])) + "</button>")
    .join("");
}

function shareDialogOeffnen() {
  if (!CUR_WALLET) return;
  SHARE_FREMD = null;
  SHARE_WER = "fremd";
  el("sharePrivat").hidden = false;
  el("shareFormat").hidden = false;
  el("shareWer").hidden = false;
  el("shareHideAddr").checked = !ZEIGE_ADRESSE;
  // Vorgewaehlt ist ein Satz mit Bild - der faellt im Feed am meisten auf.
  const saetze = SHARE_SAETZE[CUR_WALLET.tier] ?? [];
  const alle = saetze.map((s, i) => i);
  const mitBild = alle.filter((i) => SHARE_BILDER.has(CUR_WALLET.tier + "-" + saetze[i][0]));
  const auswahl = mitBild.length ? mitBild : alle;
  SHARE_WAHL = auswahl.length ? auswahl[Math.floor(Math.random() * auswahl.length)] : 0;
  SHARE_FORMAT = "karte";
  shareTexteZeigen();
  shareVorschau();
  el("shareModal").classList.add("on");
}
function shareDialogSchliessen() { el("shareModal").classList.remove("on"); }

function shareTextOeffnen(fremd) {
  if (!fremd?.text && !fremd?.varianten?.length) return;
  SHARE_FREMD = fremd;
  el("shareTitel").textContent = fremd.titel;
  el("sharePrivat").hidden = true;
  el("shareWer").hidden = true;
  // Mehrere Fassungen: eine zufaellig vorwaehlen, damit nicht jeder denselben
  // Post absetzt - genau wie beim Rang.
  // Eine vorgegebene Wahl (Wochenrueckblick: das Bild zur groessten Nachricht) gewinnt.
  SHARE_WAHL = fremd.wahl ?? (fremd.varianten ? Math.floor(Math.random() * fremd.varianten.length) : 0);
  shareTexteZeigen();
  // Mit Bild faengt der Dialog bei der Karte an - so sieht man sofort, was rausgeht.
  SHARE_FORMAT = "karte";
  shareVorschau();
  el("shareModal").classList.add("on");
}

function shareOeffnen(plattform, { text, url }) {
  // Der Link steht als eigene Zeile im Text statt als eigener Parameter: sonst
  // haengt X ihn mit einem Leerzeichen an die letzte Zeile, und Telegram setzt
  // ihn sogar vor den Text. Die Vorschaukarte erzeugen beide trotzdem.
  const voll = url ? text + "\n" + url : text;
  const zielUrl = plattform === "x"
    ? "https://twitter.com/intent/tweet?text=" + encodeURIComponent(voll)
    : "https://t.me/share/url?url=" + encodeURIComponent(voll);
  window.open(zielUrl, "_blank", "noopener,width=600,height=560");
}

function knopfMeldung(knopf, text, ms = 1800) {
  const vorher = knopf.innerHTML;
  knopf.textContent = text;
  setTimeout(() => { knopf.innerHTML = vorher; }, ms);
}

async function textKopieren(knopf, text) {
  try {
    await navigator.clipboard.writeText(text);
    knopfMeldung(knopf, "✓ Copied");
  } catch {
    prompt("Copy this text:", text);
  }
}

function bildSpeichern(id, art) {
  const a = document.createElement("a");
  a.href = shareBildUrl(id, art);
  a.download = "etn-radar-" + id + (art === "square" ? "-photo" : "") + ".jpg";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function shareAktion(knopf) {
  const aktion = knopf.dataset.aktion;
  const format = aktivesFormat();
  const id = shareBildId();

  if (aktion === "kopieren") {
    const i = shareInhalt(hauptWeg());
    return textKopieren(knopf, i.url ? i.text + "\n" + i.url : i.text);
  }
  if (aktion === "speichern") return id && bildSpeichern(id, bildArt(format));

  if (aktion === "x" || aktion === "tg") {
    shareOeffnen(aktion, shareInhalt("link"));
    // Beim Foto bleibt der Dialog offen - das Foto speichert man hier noch.
    if (format !== "foto") shareDialogSchliessen();
    return;
  }

  if (aktion === "teilen") {
    if (format === "text") {
      const i = shareInhalt("link");
      try { await navigator.share({ text: i.text + "\n" + i.url }); shareDialogSchliessen(); } catch { /* abgebrochen */ }
      return;
    }
    const art = bildArt(format);
    const datei = SHARE_FOTO.schluessel === id + "-" + art ? SHARE_FOTO.datei : null;
    if (!datei) {
      // Noch nicht geladen: nachladen, dann teilt der naechste Tipp.
      knopf.textContent = "⏳ Loading image…";
      await fotoVorladen(id, art);
      shareKnoepfe();
      return;
    }
    try {
      const i = shareInhalt("datei");
      await navigator.share({ files: [datei], text: i.url ? i.text + "\n" + i.url : i.text });
      shareDialogSchliessen();
    } catch { /* abgebrochen */ }
  }
}

// ---------- Images (Galerie + eigener Rahmen) ----------
//
// Alle Bilder, die die Seite ohnehin zum Teilen hat, zum Herunterladen: das
// gerahmte Quadrat zum Posten und die breite Karte. Die Vorschau nutzt kleine
// Thumbnails (scripts/share-bilder.mjs), sonst luede der Reiter ~10 MB.
const GAL_NAMEN = {
  humpback: ["🐋", "Humpback Whale"], whale: ["🐳", "Whale"], shark: ["🦈", "Shark"],
  dolphin: ["🐬", "Dolphin"], fish: ["🐟", "Fish"], octopus: ["🐙", "Octopus"], crab: ["🦀", "Crab"],
  shrimp: ["🦐", "Shrimp"], plankton: ["🦠", "Plankton"], microbe: ["🧫", "Microbe"], dust: ["💨", "Dust"],
};
const GAL_SONDER = [
  ["week", "week-bridge", "Busy week at the migration bridge"],
  ["week", "week-whale", "A whale made waves this week"],
  ["week", "week-busy", "Electroneum got busier this week"],
  ["week", "week-radar", "The week in numbers"],
  ["whatif", "whatif-scale", "Not a forecast. Just math."],
  ["whatif", "whatif-dream", "What if ETN were that big?"],
  ["whatif", "whatif-napkin", "Napkin math for ETN"],
  ["price", "price-hype", "Electroneum is on the move"],
  ["price", "price-next", "Where does ETN go from here?"],
  ["price", "price-napkin", "Napkin math on ETN"],
];
const GAL_GRUPPEN = [
  ["alle", "All"], ["tiers", "🐋 Tiers"], ["week", "🗓️ Weekly recap"], ["whatif", "🧮 What if"],
  ["price", "💰 ETN price"], ["banner", "📡 Banner"],
];
const GAL = { filter: "alle" };

function galEintraege() {
  const liste = [];
  for (const [tier, saetze] of Object.entries(SHARE_SAETZE)) {
    for (const [ton, satz] of saetze) {
      const id = tier + "-" + ton;
      if (!SHARE_BILDER.has(id)) continue;
      liste.push({ gruppe: "tiers", id, farbe: TIERFARBEN[tier], titel: GAL_NAMEN[tier].join(" "),
        unter: SHARE_TON[ton], satz: satz.charAt(0).toUpperCase() + satz.slice(1) });
    }
  }
  for (const [gruppe, id, satz] of GAL_SONDER) {
    liste.push({ gruppe, id, farbe: gruppe === "week" ? "#5b9cff" : "#fbbf24",
      titel: gruppe === "week" ? "🗓️ Weekly recap" : "🧮 What if", unter: "", satz });
  }
  liste.push({ gruppe: "banner", id: "banner", farbe: "#a78bfa", titel: "📡 ETN Radar", unter: "Banner", satz: "" });
  return liste;
}

function zeichneGalerie() {
  el("galFilter").innerHTML = GAL_GRUPPEN.map(([k, t]) =>
    '<button class="ghost' + (GAL.filter === k ? " on" : "") + '" data-g="' + k + '">' + t + "</button>").join("");
  const pfad = (datei) => "/assets/share/" + datei;
  const laden = (datei, text) =>
    '<a class="galknopf" href="' + pfad(datei) + '" download="etn-radar-' + datei + '">' + text + "</a>";
  el("galerie").innerHTML = galEintraege()
    .filter((b) => GAL.filter === "alle" || b.gruppe === GAL.filter)
    .map((b) => {
      const breit = b.id === "banner";
      const vorschau = breit ? "banner-thumb.jpg" : b.id + "-thumb.jpg";
      const knoepfe = breit
        ? laden("banner.jpg", "⬇️ Banner")
        : laden(b.id + "-square.jpg", "⬇️ Square") + laden(b.id + "-card.jpg", "⬇️ Wide");
      return '<figure class="galbild' + (breit ? " breit" : "") + '" style="--f:' + b.farbe + '">' +
        '<a href="' + pfad(breit ? "banner.jpg" : b.id + "-square.jpg") + '" target="_blank" rel="noopener">' +
        '<img src="' + pfad(vorschau) + '" alt="' + esc(b.titel + (b.satz ? ": " + b.satz : "")) +
        '" loading="lazy" width="360" height="' + (breit ? 189 : 360) + '"></a>' +
        "<figcaption><div class=\"galkopf\"><b>" + b.titel + "</b>" +
        (b.unter ? "<span>" + esc(b.unter) + "</span>" : "") + "</div>" +
        (b.satz ? '<div class="galsatz">' + esc(b.satz) + "</div>" : "") +
        '<div class="galknoepfe">' + knoepfe + "</div></figcaption></figure>";
    })
    .join("");
}

el("galFilter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-g]");
  if (!b) return;
  GAL.filter = b.dataset.g;
  zeichneGalerie();
});

// --- Eigener Rahmen ---------------------------------------------------------
// Derselbe Rahmen wie in scripts/share-bilder.mjs, hier mit Canvas: Linie in
// der Farbe, weiche Luecken oben links (Logo + Name) und unten rechts (Domain).
// Alles bleibt im Browser.
const RW = { bild: null, farbe: "#5b9cff", format: "1080x1080", blob: null };
const RW_FARBEN = [
  ...Object.entries(TIERFARBEN).map(([k, f]) => [f, GAL_NAMEN[k][1]]),
  ["#e8eef8", "White"],
].filter((f, i, a) => a.findIndex((x) => x[0] === f[0]) === i);
const RW_LOGO = new Image();
RW_LOGO.src = "/assets/logo-192.png";
RW_LOGO.onload = () => rwBauen();

function rwFarbenZeigen() {
  el("rwFarben").innerHTML =
    RW_FARBEN.map(([f, name]) =>
      '<button type="button" style="--c:' + f + '" title="' + esc(name) + '" aria-label="' + esc(name) +
      '" aria-pressed="' + (f === RW.farbe) + '" data-farbe="' + f + '"></button>').join("") +
    '<label class="eigene" title="Any colour"><input type="color" id="rwEigene" value="' + RW.farbe + '" aria-label="Any colour"></label>';
}

const rwHell = (hex, anteil) => {
  const n = parseInt(hex.slice(1), 16);
  return "rgb(" + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * anteil)).join(",") + ")";
};

function rwBauen() {
  if (!RW.bild || !RW_LOGO.complete) return;
  const [W, H] = RW.format.split("x").map(Number);
  const s = H < 1000 ? 0.8 : 1; // das breite Format bekommt die kleinere Variante
  const i = Math.round(46 * s), r = Math.round(30 * s), logoS = Math.round(64 * s);
  const luft = 16 * s, verlauf = 28 * s, zurEcke = 56 * s, abstand = Math.round(logoS * 0.25);

  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  const b = RW.bild;
  const f = Math.max(W / b.naturalWidth, H / b.naturalHeight);
  x.drawImage(b, (W - b.naturalWidth * f) / 2, (H - b.naturalHeight * f) / 2, b.naturalWidth * f, b.naturalHeight * f);

  const nameFont = "700 " + Math.round(34 * s) + "px 'Segoe UI', system-ui, sans-serif";
  const domFont = "700 " + Math.round(22 * s) + "px Consolas, ui-monospace, monospace";
  const domText = "etn-radar.galacticsl.com";
  x.font = nameFont; const nameW = x.measureText("ETN Radar").width;
  x.font = domFont; const domW = x.measureText(domText).width;
  const obenVon = i + r + zurEcke, obenBis = obenVon + logoS + abstand + nameW;
  const untenBis = W - i - r - zurEcke, untenVon = untenBis - domW;

  const l = document.createElement("canvas");
  l.width = W; l.height = H;
  const lx = l.getContext("2d");
  const rahmen = (breite) => { lx.beginPath(); lx.roundRect(i, i, W - 2 * i, H - 2 * i, r); lx.lineWidth = breite; lx.stroke(); };
  lx.save(); lx.filter = "blur(7px)"; lx.globalAlpha = 0.7; lx.strokeStyle = RW.farbe; rahmen(8); lx.restore();
  lx.strokeStyle = rwHell(RW.farbe, 0.35); rahmen(3);
  lx.globalCompositeOperation = "destination-out";
  const luecke = (von, bis, y) => {
    const x0 = von - luft - verlauf, x1 = bis + luft + verlauf, t = verlauf / (x1 - x0);
    const g = lx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(t, "rgba(0,0,0,1)");
    g.addColorStop(1 - t, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)");
    lx.fillStyle = g; lx.fillRect(x0, y - 30, x1 - x0, 60);
  };
  luecke(obenVon, obenBis, i);
  luecke(untenVon, untenBis, H - i);

  x.save(); x.filter = "blur(16px)"; x.fillStyle = "rgba(6,16,31,.6)";
  x.beginPath(); x.roundRect(obenVon - 12, i - logoS / 2 - 4, obenBis - obenVon + 24, logoS + 8, logoS / 2); x.fill();
  x.beginPath(); x.roundRect(untenVon - 14, H - i - 20 * s, domW + 28, 40 * s, 20 * s); x.fill();
  x.restore();
  x.drawImage(l, 0, 0);

  const text = (t, font, tx, ty) => {
    x.save(); x.font = font; x.textBaseline = "middle";
    x.shadowColor = "rgba(2,6,17,.95)"; x.shadowBlur = 10; x.fillStyle = "#fff";
    x.fillText(t, tx, ty); x.fillText(t, tx, ty); x.restore();
  };
  x.drawImage(RW_LOGO, obenVon, i - logoS / 2, logoS, logoS);
  text("ETN Radar", nameFont, obenVon + logoS + abstand, i + 1);
  text(domText, domFont, untenVon, H - i + 1);

  c.toBlob((blob) => {
    RW.blob = blob;
    const alt = el("rwBild").querySelector("img")?.src;
    if (alt) URL.revokeObjectURL(alt);
    el("rwBild").innerHTML = '<img alt="Your framed picture" src="' + URL.createObjectURL(blob) + '">';
    el("rwLaden").disabled = false;
  }, "image/jpeg", 0.9);
}

function rwLaden(datei) {
  if (!datei || !/^image\//.test(datei.type)) return;
  const b = new Image();
  b.onload = () => {
    RW.bild = b;
    el("rwAblageText").textContent = datei.name + " - drop another one to swap";
    rwBauen();
  };
  b.src = URL.createObjectURL(datei);
}

rwFarbenZeigen();
el("rwFarben").addEventListener("click", (e) => {
  const k = e.target.closest("[data-farbe]");
  if (!k) return;
  RW.farbe = k.dataset.farbe;
  rwFarbenZeigen();
  rwBauen();
});
el("rwFarben").addEventListener("input", (e) => {
  if (e.target.id !== "rwEigene") return;
  RW.farbe = e.target.value;
  el("rwFarben").querySelectorAll("[data-farbe]").forEach((k) => k.setAttribute("aria-pressed", "false"));
  rwBauen();
});
el("rwFormat").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-format]");
  if (!b) return;
  RW.format = b.dataset.format;
  el("rwFormat").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  rwBauen();
});
el("rwDatei").addEventListener("change", (e) => rwLaden(e.target.files[0]));
el("rwAblage").addEventListener("dragover", (e) => { e.preventDefault(); el("rwAblage").classList.add("drueber"); });
el("rwAblage").addEventListener("dragleave", () => el("rwAblage").classList.remove("drueber"));
el("rwAblage").addEventListener("drop", (e) => {
  e.preventDefault();
  el("rwAblage").classList.remove("drueber");
  rwLaden(e.dataTransfer.files[0]);
});
el("rwLaden").addEventListener("click", () => {
  if (!RW.blob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(RW.blob);
  a.download = "etn-radar-framed-" + RW.format + ".jpg";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

// ---------- Money flow (Sankey) ----------
//
// Zwei Diagramme statt einem: bei einer Boerse sind Ein- und Ausgaenge zwei
// verschiedene Fragen, kein Durchfluss. Links die vielen Gegenparteien, rechts
// (bzw. gespiegelt) das untersuchte Wallet - Balkenhoehe proportional zum
// Betrag, Baender dazwischen als Bezier-Kurven.
const FLUSS = { zeitraum: "7d", adresse: null, daten: null };

// Jede Gegenpartei bekommt ihre eigene Farbe. Rot bzw. Gruen bleibt allein
// dem untersuchten Wallet vorbehalten - so sieht man auf einen Blick, welcher
// Balken "man selbst" ist, und die Gegenparteien lassen sich auseinanderhalten.
const SANKEY_PALETTE = [
  "#5b9cff", "#22d3a7", "#fbbf24", "#a78bfa", "#f472b6", "#38bdf8",
  "#4ade80", "#fb923c", "#e879f9", "#2dd4bf", "#facc15", "#818cf8",
];
function sankeyFarbe(p, i) {
  if (p.rest) return "#64748b"; // "N more" bewusst unauffaellig
  return SANKEY_PALETTE[i % SANKEY_PALETTE.length];
}

function zeichneSankey(svg, seite, rein, eigenName) {
  const holder = svg.parentElement;
  const W = Math.max(300, Math.round(holder.clientWidth));
  if (W === 0) return;

  const teile = [...seite.parteien];
  if (seite.rest) {
    teile.push({ address: null, anzeige: seite.rest.anzahl + " more", etn: seite.rest.etn,
                 tx: seite.rest.tx, anteil: seite.rest.etn / (seite.gesamt_etn || 1), rest: true });
  }
  if (!teile.length) {
    svg.setAttribute("viewBox", "0 0 " + W + " 90");
    svg.style.height = "90px";
    svg.innerHTML = '<text x="' + W / 2 + '" y="50" fill="#5b6b83" font-size="13" text-anchor="middle">' +
      "no " + (rein ? "inflows" : "outflows") + " in this period</text>";
    return;
  }

  const PT = 14, PB = 14;
  const zeilenHoehe = 42;          // hoeher: mehr Luft zwischen den Baendern
  const H = Math.max(190, PT + PB + teile.length * zeilenHoehe);
  const barW = 14;
  const LABELW = Math.min(190, Math.max(120, W * 0.42));
  // Die vielen Gegenparteien stehen aussen, das eigene Wallet innen.
  const vieleX = rein ? LABELW : W - LABELW - barW;
  const einzelX = rein ? W - barW - 8 : 8;

  const gesamt = teile.reduce((s, p) => s + p.etn, 0) || 1;
  const nutzH = H - PT - PB;
  // Deutlich groessere Luecken als bisher: die Baender bekommen dadurch Raum
  // und die Kurven wirken geschwungen statt gestapelt.
  const luecke = teile.length > 1 ? Math.min(14, (nutzH * 0.22) / (teile.length - 1)) : 0;
  const balkenH = nutzH - luecke * (teile.length - 1);

  // Mindesthoehe pro Zeile, sonst kleben die Beschriftungen der kleinen
  // Betraege uebereinander (bei 13 Gegenparteien waren manche Balken 2,5 px
  // hoch, der Text braucht 14). Der Rest wird proportional verteilt - die
  // grossen Baender bleiben also erkennbar groesser, nur das Verhaeltnis am
  // unteren Ende ist gestaucht. Exakte Zahlen stehen ohnehin im Tooltip.
  const MIN_H = 15;
  const verteilbar = balkenH - MIN_H * teile.length;
  const proportional = verteilbar > 0;

  let y = PT;
  const knoten = teile.map((p, i) => {
    const h = proportional
      ? MIN_H + (p.etn / gesamt) * verteilbar
      : balkenH / teile.length;
    const k = { p, y, h, farbe: sankeyFarbe(p, i) };
    y += h + luecke;
    return k;
  });

  // Der eine Balken auf der Gegenseite ist so hoch wie alle zusammen.
  const eigenH = knoten.reduce((s, k) => s + k.h, 0) + luecke * (knoten.length - 1);
  const eigenY = PT;

  let baender = "", balken = "", texte = "";
  let lauf = eigenY;
  knoten.forEach((k, i) => {
    const h = k.h;
    const y1 = k.y, y2 = lauf;
    lauf += h;
    // Bezier von der Aussenseite zum eigenen Balken
    const x1 = rein ? vieleX + barW : vieleX;
    const x2 = rein ? einzelX : einzelX + barW;
    // Kontrollpunkte weiter aussen als die Mitte (0.68 statt 0.5): das gibt
    // eine ausgepraegte S-Kurve statt einer flachen Diagonale.
    const c1 = x1 + (x2 - x1) * 0.68;
    const c2 = x2 - (x2 - x1) * 0.68;
    const d = `M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}` +
              ` L${x2},${y2 + h} C${c2},${y2 + h} ${c1},${y1 + h} ${x1},${y1 + h} Z`;
    baender += `<path class="band" data-i="${i}" d="${d}" fill="${k.farbe}"/>`;
    balken += `<rect class="bar" data-i="${i}" x="${vieleX}" y="${y1}" width="${barW}" height="${h}" fill="${k.farbe}" rx="2"/>`;

    const name = k.p.anzeige ?? kurzAdr(k.p.address);
    const tx = rein ? vieleX - 9 : vieleX + barW + 9;
    const anker = rein ? "end" : "start";
    texte += `<text class="lbl ${k.p.anzeige ? "name" : ""}" data-i="${i}" x="${tx}" y="${y1 + h / 2 + 4}" text-anchor="${anker}">` +
      esc(name.length > 22 ? name.slice(0, 21) + "…" : name) + "</text>";
  });

  const eigenFarbe = rein ? "#22d3a7" : "#f4635e";
  balken += `<rect class="bar" data-i="self" x="${einzelX}" y="${eigenY}" width="${barW}" height="${eigenH}" fill="${eigenFarbe}" rx="2"/>`;
  const selbstX = rein ? einzelX - 9 : einzelX + barW + 9;
  texte += `<text class="lbl name" x="${selbstX}" y="${eigenY + eigenH / 2 + 4}" text-anchor="${rein ? "end" : "start"}">` +
    esc(eigenName) + "</text>";

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.style.height = H + "px";
  svg.innerHTML =
    '<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%">' +
    '<feGaussianBlur stdDeviation="3.5" result="b"/><feMerge>' +
    '<feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
    baender + balken + texte;

  // Hover: Band, beide Balken und die Beschriftung hervorheben.
  const tip = el("sankeyTip");
  holder.onmousemove = (ev) => {
    const el2 = ev.target.closest("[data-i]");
    const i = el2?.dataset.i;
    if (i == null || i === "self") { holder.classList.remove("aktiv"); tip.classList.remove("on");
      svg.querySelectorAll(".on").forEach((n) => n.classList.remove("on")); return; }
    holder.classList.add("aktiv");
    svg.querySelectorAll(".on").forEach((n) => n.classList.remove("on"));
    svg.querySelectorAll('[data-i="' + i + '"]').forEach((n) => n.classList.add("on"));
    svg.querySelector('[data-i="self"]')?.classList.add("on");

    const k = knoten[Number(i)];
    tip.innerHTML = "<b>" + esc(k.p.anzeige ?? (k.p.rest ? k.p.anzeige : kurzAdr(k.p.address))) + "</b>" +
      '<span class="num" style="color:' + k.farbe + ';font-size:14px;font-weight:650">' +
        kurz(k.p.etn) + " ETN</span>" +
      "<div>" + nf(k.p.anteil * 100, 1) + "% of " + (rein ? "inflows" : "outflows") +
        " · " + nf(k.p.tx) + " tx</div>" +
      (k.p.address ? '<div class="adr">' + k.p.address + "</div>" : "") +
      (k.p.balance_etn != null ? "<div>holds " + kurz(k.p.balance_etn) + " ETN</div>" : "") +
      (k.p.address ? '<div style="color:var(--acc);margin-top:5px">click to investigate →</div>' : "");
    tip.classList.add("on");
    tip.style.left = Math.min(ev.clientX + 16, window.innerWidth - 300) + "px";
    tip.style.top = Math.min(ev.clientY + 14, window.innerHeight - 130) + "px";
  };
  holder.onmouseleave = () => {
    holder.classList.remove("aktiv");
    tip.classList.remove("on");
    svg.querySelectorAll(".on").forEach((n) => n.classList.remove("on"));
  };
  // Klick auf eine Gegenpartei: dorthin weiterspringen.
  holder.onclick = (ev) => {
    const i = ev.target.closest("[data-i]")?.dataset.i;
    if (i == null || i === "self") return;
    const a = knoten[Number(i)]?.p.address;
    if (a) investigateAddress(a);
  };
}

async function ladeWalletFlows(adresse) {
  FLUSS.adresse = adresse;
  el("invFlowWrap").style.display = "";
  el("sankeyTip").classList.remove("on"); // Tooltip des vorigen Wallets
  el("inflowMeta").textContent = el("outflowMeta").textContent = "loading…";
  el("inflowTotal").textContent = el("outflowTotal").textContent = "—";
  el("inflowSankey").innerHTML = el("outflowSankey").innerHTML = "";

  try {
    const d = await hole("/api/wallet-flows/" + adresse + "?period=" + FLUSS.zeitraum);
    FLUSS.daten = d;
    const eigen = CUR_WALLET?.anzeige ?? kurzAdr(adresse);

    for (const [seite, svgId, metaId, totalId, rein] of [
      [d.inflow, "inflowSankey", "inflowMeta", "inflowTotal", true],
      [d.outflow, "outflowSankey", "outflowMeta", "outflowTotal", false],
    ]) {
      el(totalId).textContent = (rein ? "+" : "−") + kurz(seite.gesamt_etn) + " ETN";
      // Griff der Seitendeckel, reicht der Fluss nicht ueber den ganzen
      // Zeitraum - dann steht dabei, ab wann er tatsaechlich zaehlt.
      el(metaId).textContent =
        nf(seite.tx_anzahl) + " tx" +
        (seite.gedeckelt && seite.ab
          ? " · since " + new Date(seite.ab).toLocaleDateString(LOC, { month: "short", day: "numeric" })
          : "");
      zeichneSankey(el(svgId), seite, rein, eigen);
    }
  } catch (e) {
    el("inflowMeta").textContent = el("outflowMeta").textContent = fehlerText(e);
  }
}

function hypeText(progress) {
  const p = progress * 100;
  if (p >= 95) return "So close - will you make it? 🚀";
  if (p >= 75) return "Almost there - keep stacking! 💪";
  if (p >= 40) return "Making progress - halfway up the ladder.";
  return "Long way up, but every ETN counts. 🐾";
}

// Wallets ausserhalb der Top N: wie alt der Bestand ist, und ab einer halben
// Stunde ein Knopf, der ihn live holt. Die Bremsen (10 Minuten je Wallet,
// Minutenbudget fuer alle) sitzen auf dem Server (walletRefresh).
const REFRESH_AB_MS = 30 * 60000;
function walletStand(d) {
  const zeit = d.stand ? Date.parse(d.stand) : null;
  const alt = zeit == null || Date.now() - zeit > REFRESH_AB_MS;
  const wann = zeit == null
    ? ""
    : Date.now() - zeit < 90000
      ? "just now"
      : new Date(zeit).toLocaleString(LOC, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const text = d.quelle === "census"
    ? "📅 Balance from the weekly census" + (wann ? " of <b>" + esc(wann) + "</b>" : "")
    : "⚡ Live balance from the explorer" + (wann ? ", fetched " + esc(wann) : "");
  return '<div class="walletstand">' +
    '<span>' + text + "</span>" +
    (alt ? '<button type="button" class="ghost" id="walletRefresh" data-addr="' + esc(d.address) + '">🔄 Refresh</button>' : "") +
    "</div>";
}

async function walletAuffrischen(knopf) {
  knopf.disabled = true;
  knopf.textContent = "Refreshing…";
  try {
    const r = await fetch("/api/refresh/" + knopf.dataset.addr, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      renderWalletDetail(d, { nurKopf: true });
      return;
    }
    const minuten = d.warten_s ? Math.max(1, Math.ceil(d.warten_s / 60)) : null;
    knopf.textContent = minuten ? "Try again in " + minuten + " min" : "Try again later";
    wiederFrei(knopf, (d.warten_s ?? 60) * 1000);
  } catch {
    knopf.textContent = "Try again later";
    wiederFrei(knopf, 60000);
  }
}
// Nach der Wartezeit wieder anklickbar - sofern die Seite noch dasselbe Wallet zeigt.
function wiederFrei(knopf, ms) {
  setTimeout(() => {
    if (!knopf.isConnected) return;
    knopf.disabled = false;
    knopf.textContent = "🔄 Refresh";
  }, ms);
}

// ---------- Wallet-Wert in Dollar ----------
//
// Bestand je Tag (daily_balances) mal Tageskurs (/api/price, ein Jahr) - ohne
// eine Anfrage mehr beim Explorer. daily_balances fuehrt nur Tage MIT
// Aenderung; dazwischen gilt der letzte Stand. Ausserhalb der Top N kommt der
// Verlauf erst beim Oeffnen (/api/wallet-history, eine Explorer-Anfrage).
const WV = { address: null, verlauf: [], vollstaendig: true, etn: 0, modus: "etn", laedt: false, tokens: null, nfts: null };
let kurseLaeuft = null;
const kursTage = () =>
  (kurseLaeuft ??= hole("/api/price?period=1y")
    .then((d) => new Map((d.punkte ?? []).map((p) => [String(p.zeit).slice(0, 10), p.preis])))
    .catch(() => { kurseLaeuft = null; return new Map(); }));
let KURSE = new Map();

function dollar(v) {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e6) return s + "$" + nf(a / 1e6, 2) + "M";
  if (a >= 1e4) return s + "$" + nf(a, 0);
  return s + "$" + nf(a, a >= 100 ? 0 : 2);
}
const heuteTag = () => new Date().toISOString().slice(0, 10);
const preisJetzt = () => PREIS_JETZT ?? [...KURSE.values()].pop() ?? null;

// Bestand an einem Tag: letzter Punkt bis dahin. undefined = davor unbekannt.
function bestandAm(tag) {
  if (tag >= heuteTag()) return WV.etn;
  let wert;
  for (const p of WV.verlauf) { if (p.day > tag) break; wert = p.etn; }
  if (wert === undefined && WV.vollstaendig) return 0;
  return wert;
}
function kursAm(tag) {
  if (tag >= heuteTag()) return preisJetzt();
  let wert = null;
  for (const [t, p] of KURSE) { if (t > tag) break; wert = p; }
  return wert;
}

// Tag fuer Tag, ab dem ersten Tag mit Kurs UND bekanntem Bestand.
function wertReihe() {
  const tage = [...KURSE.keys()];
  if (!tage.length) return [];
  const ersterBestand = WV.verlauf[0]?.day ?? heuteTag();
  let t = Date.parse(WV.vollstaendig ? tage[0] : (ersterBestand > tage[0] ? ersterBestand : tage[0]));
  const ende = Date.parse(heuteTag());
  const reihe = [];
  for (; t <= ende; t += 86400000) {
    const tag = new Date(t).toISOString().slice(0, 10);
    const menge = bestandAm(tag), preis = kursAm(tag);
    if (menge === undefined || !(preis > 0)) continue;
    reihe.push({ day: tag, etn: menge * preis, menge, preis });
  }
  // Vor der ersten Bewegung liegt nichts im Wallet - die Nullstrecke weglassen.
  const erster = reihe.findIndex((p) => p.menge > 0);
  return erster > 0 ? reihe.slice(erster - 1) : reihe;
}

// Woher die Veraenderung der letzten 30 Tage kommt: vom Kurs oder vom Bestand.
// Kurs-Anteil = alter Bestand x Kursdifferenz, Bestands-Anteil = Mengendifferenz
// x heutiger Kurs - zusammen genau die Wertdifferenz.
function wertKopf() {
  const p1 = preisJetzt();
  if (!(p1 > 0)) return "";
  const b1 = WV.etn, jetzt = b1 * p1;
  const tag0 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const b0 = bestandAm(tag0), p0 = kursAm(tag0);
  let zeile = "";
  if (b0 !== undefined && p0 > 0) {
    const vorher = b0 * p0, diff = jetzt - vorher;
    const kurs = b0 * (p1 - p0), bestand = (b1 - b0) * p1;
    const farbe = (v) => (v >= 0 ? "up" : "down");
    const pz = vorher > 0 ? " (" + (diff >= 0 ? "▲ +" : "▼ -") + nf(Math.abs(diff / vorher) * 100, 1) + "%)" : "";
    zeile = '<div class="wertteile"><span>Last 30 days: <b class="num ' + farbe(diff) + '">' +
      (diff >= 0 ? "+" : "") + dollar(diff) + "</b>" + pz + "</span>" +
      (Math.abs(bestand) < Math.max(1, Math.abs(diff) * 0.005)
        ? '<span class="dim3">all from the price - the balance did not change</span>'
        : '<span>from the price <b class="num ' + farbe(kurs) + '">' + (kurs >= 0 ? "+" : "") + dollar(kurs) + "</b></span>" +
          '<span>from the balance <b class="num ' + farbe(bestand) + '">' + (bestand >= 0 ? "+" : "") + dollar(bestand) + "</b></span>") +
      "</div>";
  }
  return '<div class="wertjetzt">Worth <b class="num">' + dollar(jetzt) + '</b> <span class="dim3">at ' + wiPreis(p1) + " per ETN</span></div>" + zeile;
}

// Tokens, die im Wallet liegen: Menge, Preis und Wert. Ohne Treffer bleibt der
// Abschnitt weg - ElectroSwap kennt nur Wallets, die dort gehandelt haben.
function zeichneWalletTokens() {
  const wrap = el("invTokensWrap");
  const d = WV.tokens;
  if (!d || !d.tokens?.length) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";
  const zeilen = d.tokens.map((t) => {
    const name = t.symbol ? esc(t.symbol) : kurzAdr(t.address);
    return '<a class="tokzeile" href="' + EXPLORER + esc(t.address) + '" target="_blank" rel="noopener">' +
      '<span class="wer"><b>' + name + "</b>" + (t.name ? '<span class="dim3"> ' + esc(t.name) + "</span>" : "") + "</span>" +
      '<span class="num menge">' + kurz(t.menge) + "</span>" +
      '<span class="num wert">' + (t.wert_usd != null ? dollar(t.wert_usd) : '<span class="dim3">no price</span>') + "</span></a>";
  }).join("");
  // Tokens und ETN zusammen: der Chart daneben zeigt nur ETN, die Summe gehoert hierher.
  const etnWert = preisJetzt() > 0 ? WV.etn * preisJetzt() : null;
  el("invTokens").innerHTML = zeilen +
    '<div class="tokfuss">' +
    '<b>Tokens ' + dollar(d.gesamt_usd) + "</b>" +
    (etnWert != null
      ? '<span class="dim3"> · plus ' + dollar(etnWert) + " in ETN = </span><b>" + dollar(etnWert + d.gesamt_usd) + " total</b>"
      : "") +
    '<span class="dim3"> · prices from ElectroSwap' +
    (d.ohne_preis ? " · " + d.ohne_preis + " token(s) without a price" : "") + "</span></div>";
}

// NFT-Sammlungen des Wallets mit Mindestwert zum Bodenpreis.
function zeichneWalletNfts() {
  const wrap = el("invNftsWrap");
  const d = WV.nfts;
  if (!d || !d.sammlungen?.length) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";
  const zeilen = d.sammlungen.map((s) => {
    const name = s.name ? esc(s.name) : kurzAdr(s.address);
    const boden = s.floor_etn
      ? "floor " + kurz(s.floor_etn) + " ETN"
      : '<span class="dim3">no listing</span>';
    return '<a class="tokzeile" href="' + EXPLORER + esc(s.address) + '" target="_blank" rel="noopener">' +
      '<span class="wer"><b>' + name + "</b>" +
      (s.symbol ? '<span class="dim3"> ' + esc(s.symbol) + "</span>" : "") + "</span>" +
      '<span class="num menge">' + s.anzahl + (s.anzahl === 1 ? " NFT" : " NFTs") + "</span>" +
      '<span class="num wert">' + (s.wert_usd != null ? dollar(s.wert_usd) : boden) + "</span></a>";
  }).join("");
  el("invNfts").innerHTML = zeilen +
    '<div class="tokfuss"><b>' + d.stueck + (d.stueck === 1 ? " NFT" : " NFTs") +
    (d.gesamt_usd > 0 ? " worth at least " + dollar(d.gesamt_usd) : "") + "</b>" +
    '<span class="dim3"> · at floor price, not a valuation' +
    (d.ohne_boden ? " · " + d.ohne_boden + " collection(s) without a listing" : "") + "</span></div>";
}

function zeichneWallet() {
  if (!WV.address) return;
  el("invWert").innerHTML = WV.laedt ? "" : wertKopf();
  el("invEinheit").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.einheit === WV.modus));
  el("invChartTitel").textContent = WV.modus === "usd" ? "Value over time" : "Balance over time";
  const holder = el("invChartHolder");
  if (WV.laedt) {
    holder.innerHTML = '<div class="empty">⏳ Loading history from the explorer…</div>';
    return;
  }
  let punkte;
  if (WV.modus === "usd") {
    punkte = wertReihe();
  } else {
    // Tag fuer Tag bis heute: daily_balances fuehrt nur Tage mit Aenderung, und
    // die Achse verteilt Punkte gleichmaessig - sonst laegen bei einem ruhigen
    // Wallet zwei Jahre zwischen zwei benachbarten Punkten.
    punkte = [];
    if (WV.verlauf.length) {
      const ende = Date.parse(heuteTag());
      for (let t = Date.parse(WV.verlauf[0].day); t <= ende; t += 86400000) {
        const tag = new Date(t).toISOString().slice(0, 10);
        punkte.push({ day: tag, etn: bestandAm(tag) });
      }
    }
  }
  if (punkte.length < 2) {
    holder.innerHTML = '<div class="empty">' + (WV.modus === "usd" ? "No price history for this period yet" : "Not enough history for a chart yet") + "</div>";
    return;
  }
  if (!el("invChart")) holder.innerHTML = '<svg class="chart" id="invChart"></svg><div class="tip"></div>';
  el("invChart")._usd = WV.modus === "usd";
  zeichneChart(el("invChart"), punkte);
}

// Beim Oeffnen: Kurse (fuer alle Besucher zwischengespeichert) und - ausserhalb
// der Top N - den Verlauf nachladen. Wechselt man inzwischen das Wallet, gilt
// die spaete Antwort nicht mehr.
async function walletWertLaden(d, mitVerlauf) {
  const adr = d.address;
const [kurse, verlauf, tokens, nfts] = await Promise.all([
    kursTage(),
    mitVerlauf ? hole("/api/wallet-history/" + adr).catch(() => null) : null,
    // Tokens kommen von ElectroSwap - ein Abruf beim Oeffnen, dann 24 Stunden Ruhe.
    hole("/api/wallet-tokens/" + adr).catch(() => null),
    // NFTs: Sammlungen vom Explorer, Bodenpreis von ElectroSwap.
    hole("/api/wallet-nfts/" + adr).catch(() => null),
  ]);
  if (WV.address !== adr) return;
  KURSE = kurse;
  WV.tokens = tokens ?? null;
  WV.nfts = nfts ?? null;
  zeichneWalletTokens();
  zeichneWalletNfts();
  if (mitVerlauf) {
    WV.laedt = false;
    if (verlauf?.verlauf) {
      WV.verlauf = verlauf.verlauf;
      WV.vollstaendig = !!verlauf.vollstaendig;
    }
  }
  zeichneWallet();
}

el("invEinheit").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-einheit]");
  if (!b || b.dataset.einheit === WV.modus) return;
  WV.modus = b.dataset.einheit;
  zeichneWallet();
});

function renderWalletDetail(d, { nurKopf = false } = {}) {
  const wrap = { chart: el("invChartWrap"), cluster: el("invClusterWrap"), events: el("invEventsWrap"), fluss: el("invFlowWrap") };
  const bis = d.bis_naechster_tier;
  // Ausserhalb der Top N: kein Verlauf, keine Ereignisse, kein Cluster.
  const liveOnly = d.quelle === "explorer" || d.quelle === "census" || d.quelle === "census_live";

  el("invHead").innerHTML =
    '<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">' +
    '<div style="font-size:60px;line-height:1">' + d.tier_emoji + "</div>" +
    '<div style="flex:1;min-width:210px">' +
    '<div style="font-size:21px;font-weight:640">' + esc(d.anzeige ?? d.tier_name) +
      '<span style="font-size:11px;font-weight:400">' + walletTags(d) + "</span></div>" +
    (d.anzeige ? '<div class="dim" style="font-size:12.5px">' + esc(d.tier_name) + "</div>" : "") +
    '<a class="addr" href="' + EXPLORER + d.address + '" target="_blank" rel="noopener" style="margin-top:3px;display:inline-block">' +
      kurzAdr(d.address) + " ↗</a>" +
      '<button class="ghost linkkopie" id="walletLink" type="button">🔗 Copy link</button>' +
      notizBox(d.address, "+ add a note about this wallet") + "</div>" +
    '<div style="text-align:right"><div class="num" style="font-size:25px;font-weight:660">' +
    kurz(d.etn) + ' <span style="font-size:.5em;color:var(--tx2)">ETN</span></div>' +
    '<div class="dim3" style="font-size:12px">' +
    (d.in_top_n
      ? "rank " + d.rank_pos
      : d.census_rang
        ? "rank ~" + nf(d.census_rang) + " · weekly census"
        : "outside the tracked list") + "</div></div></div>" +
    (bis != null
      ? '<div class="progress"><i style="width:' + (d.tier_progress * 100).toFixed(1) + '%"></i></div>' +
        '<div style="font-size:13.5px;color:var(--tx2)">' + esc(d.tier_name) + ' → <b>' + esc(d.naechster_tier) +
        '</b> · another <b class="num" style="color:var(--acc)">' + nf(bis) + " ETN</b> to go</div>" +
        '<div style="font-size:12.5px;color:var(--acc2);margin-top:4px;font-weight:560">' + hypeText(d.tier_progress) + "</div>"
      : '<div style="margin-top:11px;font-size:13.5px;color:var(--acc2)">Highest tier reached 🎉 - nowhere left to climb.</div>') +
    (liveOnly ? walletStand(d) : "") +
    shareBlock(d.address);

  CUR_WALLET = d;
  // Die Adresszeile zeigt die Wallet - so laesst sie sich als Link teilen.
  if (el("page-investigate").classList.contains("on")) adresseSetzen("/wallet/" + d.address, false);

  // Die Fluss-Diagramme kommen live vom Explorer, nicht aus der Datenbank -
  // sie funktionieren deshalb auch fuer Wallets ausserhalb der verfolgten
  // Top N, wo es sonst nichts zu zeigen gaebe.
  // Beim Auffrischen nicht: der Fluss kostet bis zu zwanzig Explorer-Anfragen.
  if (!nurKopf) ladeWalletFlows(d.address).catch((e) => console.error("flows:", e));

  // Chart: Bestand oder Dollarwert. Beim Auffrischen nur der heutige Punkt neu.
  wrap.chart.style.display = "";
  if (nurKopf && WV.address === d.address) {
    WV.etn = d.etn;
    zeichneWallet();
    zeichneWalletTokens();
    zeichneWalletNfts();
  } else {
    // Ausserhalb der Top N (und fuer herausgefallene) holt der Server den
    // Verlauf erst jetzt - hoechstens alle zwoelf Stunden je Wallet.
    const nachladen = liveOnly || !d.in_top_n;
    Object.assign(WV, {
      tokens: null,
      nfts: null,
      address: d.address,
      verlauf: d.verlauf ?? [],
      vollstaendig: !liveOnly,
      etn: d.etn,
      laedt: liveOnly,
    });
    zeichneWallet();
    walletWertLaden(d, nachladen).catch((e) => console.error("wert:", e));
  }

  if (liveOnly) {
    wrap.cluster.style.display = wrap.events.style.display = "none";
    return;
  }

  // Cluster-Bezug
  const c = d.cluster ?? {};
  const teile = [];
  if (c.finanziert_von) {
    const q = c.finanziert_von;
    teile.push(
      '<div class="cmember"><div class="em">⬅️</div>' +
      '<div class="id">Funded ' + Math.round(q.funding_share * 100) + '% by <b>' +
        esc(q.quelle_label ?? kurzAdr(q.funding_source)) + "</b>" +
        (q.quelle_typ ? " (" + esc(q.quelle_typ) + ")" : "") + "</div></div>"
    );
  }
  if (c.finanziert_selbst?.length) {
    teile.push('<div style="font-size:12.5px;color:var(--tx2);margin:10px 0 4px">Funds ' + c.finanziert_selbst.length + ' other tracked wallet(s):</div>');
    teile.push(c.finanziert_selbst.map((m) =>
      '<a class="cmember" href="' + EXPLORER + m.address + '" target="_blank" rel="noopener">' +
      '<div class="em">➡️</div><div class="id">' + kurzAdr(m.address) + '</div>' +
      '<div class="val"><b class="num">' + kurz(m.etn) + " ETN</b>" +
      "<span>" + Math.round(m.funding_share * 100) + "% from this wallet</span></div></a>"
    ).join(""));
  }
  if (teile.length) {
    wrap.cluster.style.display = wrap.cluster.hasAttribute("hidden") ? "none" : "";
    el("invCluster").innerHTML = teile.join("");
  } else {
    wrap.cluster.style.display = "";
    el("invCluster").innerHTML = '<div class="empty">No funding-source relationship detected for this wallet.</div>';
  }

  // Ereignisse
  wrap.events.style.display = "";
  el("invEvents").innerHTML = d.ereignisse?.length
    ? d.ereignisse.map((e) => {
        const k = EV[e.type] ?? { i: "•", f: "#64748b", t: e.type };
        return '<div class="ev">' +
          '<div class="ic" style="background:' + k.f + '1c;color:' + k.f + '">' + k.i + "</div>" +
          '<div class="tx"><b>' + k.t + evBetrag(e) +
          nebenrollen(e) + "</b>" +
          (e.tier_from ? "<div>" + e.tier_from + " → " + e.tier_to + "</div>" : "") + "</div>" +
          '<div class="when">' + zeitHer(e.detected_at) + "</div></div>";
      }).join("")
    : '<div class="empty">Nothing flagged yet - this wallet has not moved 100,000 ETN or more ' +
      'in one go since tracking started.</div>';
}

/** Springt zum Investigate-Tab und laedt sofort ein bestimmtes Wallet - Ziel
    des rechten Mausklicks "Investigate" ueberall im Dashboard. */
function investigateAddress(addr, neu = true) {
  el("invQ").value = addr;
  el("invQ").dispatchEvent(new Event("input"));
  zeigeSeite("investigate", neu);
  ladeWalletDetail(addr).catch((e) => console.error("investigate:", e));
}

/** Link in die Zwischenablage. Wo das nicht erlaubt ist (manche eingebetteten
    Ansichten), zeigt ein Dialog den Link zum Kopieren von Hand. */
async function linkKopieren(knopf, url) {
  try {
    await navigator.clipboard.writeText(url);
    const vorher = knopf.textContent;
    knopf.textContent = "✓ Link copied";
    setTimeout(() => { knopf.textContent = vorher; }, 1800);
  } catch {
    prompt("Copy this link:", url);
  }
}

el("invGoBtn").onclick = () => {
  const q = el("invQ").value.trim();
  if (q) ladeWalletDetail(q).catch((e) => console.error("investigate:", e));
};
el("invQ").addEventListener("keydown", (e) => { if (e.key === "Enter") el("invGoBtn").click(); });
el("invHead").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-addr]");
  if (a) { el("invQ").value = a.dataset.addr; el("invQ").dispatchEvent(new Event("input")); ladeWalletDetail(a.dataset.addr).catch(console.error); return; }
  const kopie = e.target.closest("#walletLink");
  if (kopie && CUR_WALLET) { linkKopieren(kopie, location.origin + "/wallet/" + CUR_WALLET.address); return; }
  if (e.target.closest("#shareOpen")) { shareDialogOeffnen(); return; }
  const neu = e.target.closest("#walletRefresh");
  if (neu && !neu.disabled) { walletAuffrischen(neu); return; }
});

// Share-Dialog: ein Knopf, darin die Wahl der Plattform und der Sichtbarkeit.
el("shareClose").onclick = shareDialogSchliessen;
el("shareModal").addEventListener("click", (e) => {
  if (e.target === el("shareModal")) shareDialogSchliessen(); // Klick auf den Hintergrund
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && el("shareModal").classList.contains("on")) shareDialogSchliessen();
});
el("shareHideAddr").addEventListener("change", (e) => {
  ZEIGE_ADRESSE = !e.target.checked;
  shareVorschau();
});
el("shareTexte").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-i]");
  if (!b) return;
  SHARE_WAHL = Number(b.dataset.i);
  shareTexteZeigen();
  shareVorschau();
});
el("shareWer").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-wer]");
  if (!b) return;
  SHARE_WER = b.dataset.wer;
  shareVorschau();
});
el("shareFormat").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-format]");
  if (!b || b.disabled) return;
  SHARE_FORMAT = b.dataset.format;
  shareVorschau();
});
for (const leiste of ["shareFoot", "shareMehr"]) {
  el(leiste).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-aktion]");
    if (b) shareAktion(b);
  });
}

// ---------- Rechtsklick-Menue: "Investigate" auf jeder Wallet-Adresse ----------
//
// Ein einziger, delegierter Listener statt einem pro Zeile: erfasst auch
// Adressen, die erst spaeter dynamisch gerendert werden (Leaderboard-Seiten,
// Cluster-Ergebnisse, ...). Linksklick auf dieselben Links bleibt unveraendert
// und geht weiter direkt zum externen Explorer.
(function () {
  let menu = null;
  function schliessen() { if (menu) { menu.remove(); menu = null; } }
  document.addEventListener("contextmenu", (e) => {
    // Nicht nur der Link selbst: in einer Tabellenzeile muesste man sonst die
    // Adresse millimetergenau treffen. Trifft der Klick irgendwo in eine
    // Zeile/Karte mit genau einer Wallet-Adresse, ist die gemeint.
    let a = e.target.closest('a[href^="' + EXPLORER + '"]');
    if (!a) {
      const zeile = e.target.closest("tr, .mv, .ev, .cmember, .flowex");
      const treffer = zeile?.querySelectorAll('a[href^="' + EXPLORER + '"]');
      if (treffer?.length === 1) a = treffer[0];
    }
    if (!a) return;
    e.preventDefault();
    schliessen();
    const addr = a.getAttribute("href").slice(EXPLORER.length);
    menu = document.createElement("div");
    menu.className = "ctxmenu";
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    menu.innerHTML = '<button>🔎 Investigate this wallet</button>';
    menu.querySelector("button").onclick = () => { schliessen(); investigateAddress(addr); };
    document.body.appendChild(menu);
  });
  document.addEventListener("click", schliessen);
  window.addEventListener("scroll", schliessen, true);
})();

// ---------- Info-Popup: kleines "ⓘ" statt Dauertext ----------
//
// Fuer Erklaerungen, die wichtig sind, aber nicht staendig im Weg stehen
// sollen: <button class="infoBtn" data-info="...">ⓘ</button> irgendwo im
// Markup, ein einziger delegierter Listener oeffnet/schliesst die Bubble.
(function () {
  let pop = null;
  function schliessen() { if (pop) { pop.remove(); pop = null; } }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".infoBtn");
    const drinnen = e.target.closest(".infopop");
    if (!btn && !drinnen) { schliessen(); return; }
    if (!btn) return;
    e.stopPropagation();
    const schonOffen = pop && pop.dataset.fuer === btn.dataset.info;
    schliessen();
    if (schonOffen) return; // zweiter Klick auf denselben Knopf schliesst nur
    pop = document.createElement("div");
    pop.className = "infopop";
    pop.dataset.fuer = btn.dataset.info;
    pop.textContent = btn.dataset.info;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth;
    let left = Math.min(r.left, window.innerWidth - pw - 12);
    pop.style.left = Math.max(12, left) + "px";
    pop.style.top = (r.bottom + 7) + "px";
  });
  window.addEventListener("scroll", schliessen, true);
})();

// ---------- Wallet lookup ----------
async function suchen() {
  const q = el("q").value.trim();
  const box = el("searchResult");
  if (!q) return;
  box.className = "result show";
  box.innerHTML = '<div class="skel" style="height:74px"></div>';
  try {
    const d = await hole("/api/search?q=" + encodeURIComponent(q));
    if (d.treffer) {
      box.innerHTML = d.treffer.length
        ? d.treffer.map((e) => zeileMover({ ...e, delta_etn: 0, delta_pct: 0 }, true)).join("")
        : '<div class="empty">Nothing found</div>';
      return;
    }
    const bis = d.bis_naechster_tier;
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">' +
      '<div style="font-size:60px;line-height:1">' + d.tier_emoji + "</div>" +
      '<div style="flex:1;min-width:210px">' +
      '<div style="font-size:21px;font-weight:640">' + esc(d.tier_name) + "</div>" +
      '<div class="addr" style="margin-top:2px">' + kurzAdr(d.address) + "</div></div>" +
      '<div style="text-align:right"><div class="num" style="font-size:25px;font-weight:660">' +
      kurz(d.etn) + ' <span style="font-size:.5em;color:var(--tx2)">ETN</span></div>' +
      '<div class="dim3" style="font-size:12px">' +
      (d.in_top_n ? "rank " + d.rank_pos : "outside the tracked list") + "</div></div></div>" +
      (bis != null
        ? '<div class="progress"><i style="width:' + (d.tier_progress * 100).toFixed(1) + '%"></i></div>' +
          '<div style="font-size:13.5px;color:var(--tx2)">Another <b class="num" style="color:var(--acc)">' +
          nf(bis) + " ETN</b> to reach <b>" + esc(d.naechster_tier) + "</b></div>"
        : '<div style="margin-top:11px;font-size:13.5px;color:var(--acc2)">Highest tier reached 🎉</div>') +
      (d.quelle === "explorer"
        ? '<div class="dim3" style="font-size:11.5px;margin-top:9px">Fetched live from the explorer - this wallet is outside the tracked top N.</div>'
        : "") +
      // Statt hier alles zu wiederholen: rueber zur vollen Profilseite, wo
      // Chart, Ereignisse, Cluster und der Share-Dialog ohnehin schon leben.
      '<div class="sharebar"><button id="zurProfilseite" data-addr="' + esc(d.address) + '">' +
      "🔎 Full profile &amp; share</button></div>";
  } catch (e) {
    box.innerHTML = '<div class="empty">' + esc(fehlerText(e)) + "</div>";
  }
}

// ---------- Tabs ----------
//
// Jede Seite laedt ihre Daten beim ersten Oeffnen. Das haelt den Erststart
// schlank und spart Anfragen an Endpoints, die der Nutzer nie ansieht.
const geladen = new Set();

// Uebersicht und Tiers-Reiter fuellen sich aus EINEM /api/overview-Aufruf.
// Ohne die gemeinsam genutzte Zusage fragt der zweite geoeffnete Reiter
// denselben Endpoint noch einmal ab, nur um dieselben Zahlen zu bekommen.
let uebersichtLaeuft = null;
const uebersicht = () => (uebersichtLaeuft ??= ladeOverview());

const LADER = {
  overview: () =>
    Promise.all([uebersicht(), ladeNetzwerk(), ladeKurs(), chainDaten(), ladeWatchlist(), fbBesucher()]),
  // Reihenfolge ist hier wichtig, nicht Geschmack: ladeOverview() schreibt den
  // Kopfbereich fuer die Zeit VOR dem Stichtag, ladeBilanz() ueberschreibt ihn
  // danach. Parallel gestartet gewaenne mal der eine, mal der andere.
  migration: async () => {
    await uebersicht();
    await Promise.all([ladeBilanz(), ladeMigrationen(), ladeBridgeVerlauf(), ladeJobStatus("bridge", "bridgeBtn")]);
  },
  tiers: () => Promise.all([uebersicht(), ladeTierVerlauf()]),
  about: () => Promise.resolve(),
  board: () => ladeLeaderboard(),
  activity: () =>
    Promise.all([ladeWatchlist(), ladeMovers("7d"), ladeSleepers(), ladeEvents(), ladeExchangeFlow()]),
  chain: () => chainDaten(),
  whatif: () => ladeWhatif(),
  images: async () => zeichneGalerie(),
  clusters: () => Promise.all([ladeClusters(), ladeJobStatus("clusters", "clustersBtn")]),
  // Wartet auf eine Suche - die Merkliste ist das einzige, was hier von
  // selbst etwas zu zeigen hat, und genau dort ist sie am nuetzlichsten.
  investigate: () => ladeWatchlist(),
};

function zeigeSeite(name, neu = true) {
  if (typeof ZAEHLER !== "undefined" && name) ZAEHLER.bereiche.add(name);
  // Ausgeblendete Bereiche (labs) duerfen auch nicht ueber die Adresszeile
  // erreichbar sein - sonst kommt jeder ueber "#clusters" auf die noch
  // ungeprueften Cluster-Vermutungen, samt Betreiber-Knopf.
  const navKnopf = document.querySelector('#nav [data-p="' + name + '"]');
  if (navKnopf?.hasAttribute("hidden")) name = "overview";

  const wechsel = document.querySelector("#nav button.on")?.dataset.p !== name;
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("on", p.id === "page-" + name));
  if (wechsel) window.scrollTo({ top: 0 });
  el("nav").querySelectorAll("button[data-p]").forEach((b) => b.classList.toggle("on", b.dataset.p === name));
  // Am Handy passen nicht alle Reiter nebeneinander: den aktiven in die Mitte
  // der Leiste holen, sonst sieht man nach /leaderboard gar nicht, wo man ist.
  const aktiv = document.querySelector('#nav button[data-p="' + name + '"]');
  const leiste = aktiv?.parentElement;
  if (leiste && leiste.scrollWidth > leiste.clientWidth) {
    // Direkt gesetzt statt weich gescrollt: eine weiche Bewegung bricht ab,
    // wenn gleich danach der Inhalt der Seite neu aufgebaut wird.
    leiste.scrollLeft = aktiv.offsetLeft - leiste.offsetLeft - (leiste.clientWidth - aktiv.offsetWidth) / 2;
  }
  // Auf Investigate mit geladener Wallet bleibt deren Adresse stehen.
  adresseSetzen(
    name === "investigate" && CUR_WALLET ? "/wallet/" + CUR_WALLET.address : pfadVon(name),
    neu && wechsel
  );
  if (!geladen.has(name)) {
    geladen.add(name);
    LADER[name]().catch((err) => console.error(name + ":", err));
  }
  // Der Chart wurde eventuell in einem versteckten Tab gezeichnet und hatte
  // dort die Breite 0 - beim Einblenden neu vermessen.
  if (name === "overview" || name === "tiers" || name === "migration" || name === "chain") alleChartsNachziehen();
  if (name === "activity" && FLOW.punkte) zeichneFlowChart(el("flowChart"));
}

el("watchClear").onclick = () => {
  if (!confirm("Remove all wallets from your watchlist?")) return;
  watchSpeichern([]);
  document.querySelectorAll(".star.on").forEach((b) => {
    b.classList.remove("on");
    b.textContent = "☆";
  });
  ladeWatchlist();
};

el("nav").onclick = (e) => {
  const b = e.target.closest("button[data-p]");
  if (b) zeigeSeite(b.dataset.p);
};

/* ---------- Adressen der Bereiche -------------------------------------------
 *
 * Saubere Pfade statt "#anker": /migration, /leaderboard, /wallet/0x... Eine
 * untersuchte Wallet laesst sich so als Link weitergeben - vorher stand in der
 * Adresszeile nur "#investigate", und wer den Link bekam, sah ein leeres
 * Suchfeld. Der Worker liefert fuer jeden dieser Pfade dieselbe Seite aus.
 *
 * Alte Links mit "#investigate" usw. funktionieren weiter und werden beim
 * Oeffnen auf den Pfad umgeschrieben.
 */
const PFADE = { overview: "/", board: "/leaderboard" };
const pfadVon = (name) => PFADE[name] ?? "/" + name;

function seiteAusPfad(pfad) {
  const p = pfad.replace(/\/+$/, "") || "/";
  const w = p.match(/^\/wallet\/([^/]+)$/);
  if (w) return { seite: "investigate", wallet: decodeURIComponent(w[1]) };
  return { seite: Object.keys(LADER).find((n) => pfadVon(n) === p) ?? null };
}

/** neu = true legt einen Verlaufseintrag an, damit "Zurueck" funktioniert. */
function adresseSetzen(pfad, neu) {
  if (location.pathname === pfad && !location.hash) return;
  const url = pfad + location.search;
  if (neu) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

addEventListener("popstate", () => {
  // Ein von Hand getippter alter Anker kommt gleich als hashchange.
  if (LADER[location.hash.slice(1)]) return;
  const z = seiteAusPfad(location.pathname);
  if (z.wallet && z.wallet.toLowerCase() !== String(CUR_WALLET?.address ?? "").toLowerCase()) {
    investigateAddress(z.wallet, false);
  } else {
    zeigeSeite(z.seite ?? "overview", false);
  }
});

addEventListener("hashchange", () => {
  const ziel = location.hash.slice(1);
  if (LADER[ziel]) zeigeSeite(ziel);
});

// Links auf Bereiche (Logo, Fusszeile) wechseln ohne Neuladen. Mit Strg/Cmd
// bleibt es ein normaler Link, der in einem neuen Tab aufgeht. Ist der Bereich
// schon offen, geht es wenigstens nach oben - sonst taete der Klick nichts.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-seite]");
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  if (document.querySelector("#nav button.on")?.dataset.p === a.dataset.seite) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  zeigeSeite(a.dataset.seite);
});

// ---------- Wiring ----------
// ---------- Manual job triggers (census, clusters) ----------
//
// Generisch fuer beide "Run now"-Knoepfe: gleiche API-Form
// (/api/<job>/status, /api/<job>/trigger), gleiche Sperr-Logik.
function zeitDauer(ms) {
  const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? h + "h " + m + "m" : m + "m";
}
const JOB_LABEL = {
  census: "🔄 Run full census now",
  clusters: "🔍 Run cluster analysis now",
  exchanges: "🔍 Detect exchanges",
  bridge: "🔍 Scan for events now",
};

async function ladeJobStatus(job, btnId) {
  const btn = el(btnId);
  const label = JOB_LABEL[job];
  try {
    const s = await hole("/api/" + job + "/status");
    // Betreiber-Knopf: fuer normale Besucher gar nicht erst anzeigen.
    if (s.admin_noetig && !s.admin_ok) {
      btn.style.display = "none";
      return;
    }
    btn.style.display = "";
    btn.disabled = !s.bereit;
    btn.textContent = s.bereit ? label : "Available in " + zeitDauer(s.wartezeit_ms);
  } catch {
    // Im Zweifel VERSTECKT lassen. Ein Knopf, der nur 403 kann, hilft
    // niemandem - und einer, der bei Netzproblemen aufpoppt, verraet
    // Besuchern eine Funktion, die ihnen nicht zusteht.
    btn.style.display = "none";
  }
}
function wireJobButton(job, btnId) {
  el(btnId).onclick = async () => {
    const btn = el(btnId);
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      const r = await fetch("/api/" + job + "/trigger", { method: "POST", headers: adminKopf() });
      const d = await r.json();
      btn.textContent = d.ok
        ? "✓ Started - takes ~15-30 min"
        : d.grund === "nicht_konfiguriert"
        ? "Not configured - see Actions tab"
        : d.grund === "kein_zugriff"
        ? "Operator only"
        : "Failed - try again later";
    } catch {
      btn.textContent = "Failed - try again later";
    }
    setTimeout(() => ladeJobStatus(job, btnId), 4000);
  };
}
wireJobButton("census", "censusBtn");
wireJobButton("exchanges", "exchangesBtn");
ladeJobStatus("exchanges", "exchangesBtn").catch(() => {});
wireJobButton("clusters", "clustersBtn");
wireJobButton("bridge", "bridgeBtn");
ladeJobStatus("census", "censusBtn").catch(() => {});

el("activityRefresh").onclick = async () => {
  const btn = el("activityRefresh");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    await Promise.all([
      ladeMovers(letzterMoverZeitraum, true),
      ladeSleepers(true),
      ladeEvents(true),
      ladeExchangeFlow(),
    ]);
  } catch (e) {
    console.error("Refresh:", e);
  }
  btn.disabled = false;
  btn.textContent = "🔄 Refresh";
};

el("goBtn").onclick = suchen;
el("q").addEventListener("keydown", (e) => { if (e.key === "Enter") suchen(); });
el("searchResult").addEventListener("click", (e) => {
  const b = e.target.closest("#zurProfilseite");
  if (b) investigateAddress(b.dataset.addr);
});

periodTabs(el("moverTabs"), "7d", (p) => ladeMovers(p).catch(console.error));
periodTabs(el("flowPeriods"), "30d", (p) => {
  FLOW.zeitraum = p;
  ladeExchangeFlow().catch(console.error);
});
// Nur hier ein Jahr: der Geldfluss kostet pro Klick hoechstens 10 Seiten je
// Richtung, egal wie lang der Zeitraum ist. Movers, Leaderboard und
// Boersenfluss rechnen dagegen in der eigenen Datenbank.
periodTabs(el("flowPeriodTabs"), "7d", (p) => {
  FLUSS.zeitraum = p;
  if (FLUSS.adresse) ladeWalletFlows(FLUSS.adresse).catch(console.error);
}, [...PERIODEN, { k: "1y", t: "1Y" }]);
// Bei Groessenaenderung neu zeichnen - die Balken sind pixelgenau gesetzt.
beobachte("invFlowWrap", () => {
  if (!FLUSS.daten) return;
  const eigen = CUR_WALLET?.anzeige ?? kurzAdr(FLUSS.adresse ?? "");
  zeichneSankey(el("inflowSankey"), FLUSS.daten.inflow, true, eigen);
  zeichneSankey(el("outflowSankey"), FLUSS.daten.outflow, false, eigen);
});
el("flowAuto").onclick = () => {
  FLOW.inklAuto = !FLOW.inklAuto;
  ladeExchangeFlow().catch(console.error);
};

el("prevPage").onclick = () => { LB.offset = Math.max(0, LB.offset - LB.limit); ladeLeaderboard(); };
el("nextPage").onclick = () => { LB.offset += LB.limit; ladeLeaderboard(); };
document.querySelectorAll("[data-n]").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("[data-n]").forEach((x) => x.classList.toggle("on", x === b));
    LB.limit = Number(b.dataset.n);
    LB.offset = 0;
    ladeLeaderboard();
  };
});
// Die beiden Filter sind Gegenteile - beide gleichzeitig ergaebe eine immer
// leere Liste.
el("hideEx").onclick = () => {
  LB.nurEcht = !LB.nurEcht;
  if (LB.nurEcht) LB.nurDienste = false;
  filterKnoepfe();
};
el("onlyEx").onclick = () => {
  LB.nurDienste = !LB.nurDienste;
  if (LB.nurDienste) LB.nurEcht = false;
  filterKnoepfe();
};
function filterKnoepfe() {
  el("hideEx").classList.toggle("on", LB.nurEcht);
  el("onlyEx").classList.toggle("on", LB.nurDienste);
  LB.offset = 0;
  ladeLeaderboard();
}

// ---------- Seitensprung ----------
function lbSeiteSpringen() {
  // Nach oben begrenzen, nicht nur nach unten. Ein Sprung auf Seite 60 bei
  // zwei vorhandenen Seiten ergab sonst eine leere Tabelle und die Zeile
  // "2.951-71 of 71 (page 60/2)" - eine rueckwaerts laufende Spanne.
  const letzte = Math.max(1, Math.ceil((LB.gesamt || 1) / LB.limit));
  const seite = Math.min(letzte, Math.max(1, parseInt(el("pageJump").value, 10) || 1));
  el("pageJump").value = "";
  LB.offset = (seite - 1) * LB.limit;
  ladeLeaderboard();
}
el("pageJumpBtn").onclick = lbSeiteSpringen;
el("pageJump").addEventListener("keydown", (e) => { if (e.key === "Enter") lbSeiteSpringen(); });
// Nur Ziffern. inputmode="numeric" zeigt auf dem Handy die Zahlentastatur, haelt
// am Rechner aber niemanden davon ab, Buchstaben zu tippen - die landeten dann
// stillschweigend auf Seite 1. Gefiltert beim Tippen UND beim Einfuegen.
el("pageJump").addEventListener("input", (e) => {
  const nurZiffern = e.target.value.replace(/[^0-9]/g, "").slice(0, 5);
  if (nurZiffern !== e.target.value) e.target.value = nurZiffern;
});

// ---------- Balance-Filter ----------
// Presets grob an der Tier-Skala orientiert - deckt die typischen Fragen ab
// ("nur die ganz Kleinen", "Whale-Bereich", ...) ohne dass man selbst rechnen muss.
const ETN_PRESETS = [
  { t: "All", min: null, max: null },
  { t: "< 100K", min: null, max: 100000 },
  { t: "100K–500K", min: 100000, max: 500000 },
  { t: "500K–2M", min: 500000, max: 2000000 },
  { t: "2M–10M", min: 2000000, max: 10000000 },
  { t: "10M+", min: 10000000, max: null },
];
function zeigeRangeUI() {
  [...el("etnPresets").children].forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.min || 0) === (LB.minEtn ?? 0) &&
      (b.dataset.max ? Number(b.dataset.max) : null) === LB.maxEtn)
  );
}
el("etnPresets").innerHTML = ETN_PRESETS.map((p) =>
  '<button class="ghost' + (p.min == null && p.max == null ? " on" : "") + '" data-min="' +
    (p.min ?? "") + '" data-max="' + (p.max ?? "") + '">' + p.t + "</button>"
).join("");
el("etnPresets").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  LB.minEtn = b.dataset.min ? Number(b.dataset.min) : null;
  LB.maxEtn = b.dataset.max ? Number(b.dataset.max) : null;
  LB.offset = 0;
  zeigeRangeUI();
  ladeLeaderboard();
};

// ---------- Wallet-Suche: springt direkt zur richtigen Seite ----------
async function lbSpringeZuWallet() {
  const q = el("lbSearch").value.trim();
  const msg = el("lbSearchMsg");
  if (!q) return;
  msg.style.display = "";
  msg.textContent = "Searching …";
  try {
    const d = await hole("/api/search?q=" + encodeURIComponent(q));
    if (d.treffer) {
      if (!d.treffer.length) { msg.textContent = "No match found."; return; }
      if (d.treffer.length > 1) {
        msg.textContent = d.treffer.length + " matches for \"" + q + "\" - be more specific, or use one address.";
        return;
      }
      return lbSpringeZuRang(d.treffer[0].rank_pos, d.treffer[0].address, msg);
    }
    // Census-Wallets stehen auch in der Liste - mit ihrem Platz vom letzten Census.
    if (d.census_rang) return lbSpringeZuRang(d.census_rang, d.address, msg);
    if (d.quelle === "explorer" || !d.in_top_n) {
      msg.textContent = "Found, but below 25K ETN - too small to appear in the leaderboard.";
      return;
    }
    return lbSpringeZuRang(d.rank_pos, d.address, msg);
  } catch (e) {
    msg.textContent = fehlerText(e);
  }
}
async function lbSpringeZuRang(rang, addr, msg) {
  if (rang == null) { msg.textContent = "Found, but its rank is unknown."; return; }
  // Filter, die die Nummerierung verschieben wuerden, erst zuruecksetzen -
  // sonst landet der Sprung an der falschen Seite.
  LB.nurEcht = false;
  el("hideEx").classList.remove("on");
  LB.minEtn = null; LB.maxEtn = null;
  zeigeRangeUI();
  msg.style.display = "none";

  // rank_pos ist der GLOBALE Rang (inkl. Bridge), "platz" in der Liste zaehlt
  // ohne die Bridge - ein Offset von 1 ist darum normal. Um das nicht exakt
  // nachrechnen zu muessen: geschaetzte Seite laden, und falls die Adresse
  // dort nicht auftaucht, eine Seite vor/zurueck nachschauen.
  const geschaetzt = Math.floor((rang - 1) / LB.limit) * LB.limit;
  for (const off of [geschaetzt, geschaetzt + LB.limit, geschaetzt - LB.limit]) {
    if (off < 0) continue;
    LB.offset = off;
    await ladeLeaderboard();
    const row = [...el("lbBody").querySelectorAll("a.addr")]
      .find((a) => a.getAttribute("href") === EXPLORER + addr)
      ?.closest("tr");
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("rowhit");
      setTimeout(() => row.classList.remove("rowhit"), 2200);
      return;
    }
  }
  msg.style.display = "";
  msg.textContent = "Found it, but couldn't land on its exact page - try the balance filters below.";
}
el("lbSearchBtn").onclick = lbSpringeZuWallet;
el("lbSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") lbSpringeZuWallet(); });

/* ---------- Suchfelder leeren ---------------------------------------------
 *
 * Das X erscheint erst, wenn etwas im Feld steht - ein Knopf, der nichts tun
 * kann, ist nur Unruhe. Escape tut dasselbe. Danach bleibt der Cursor im Feld,
 * sonst muesste man fuer die naechste Suche erst wieder hineinklicken, und das
 * X haette nichts gespart.
 *
 * Mit dem Feld verschwindet auch, was die Suche angezeigt hat: ein leeres
 * Suchfeld ueber einem stehengebliebenen Ergebnis widerspricht sich.
 */
function leerenVerdrahten(id, zuruecksetzen) {
  const feld = el(id);
  const knopf = feld.parentElement.querySelector(".leeren");
  const zeigen = () => { knopf.hidden = !feld.value; };
  const leeren = () => {
    feld.value = "";
    zeigen();
    zuruecksetzen();
    feld.focus();
  };
  feld.addEventListener("input", zeigen);
  feld.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && feld.value) {
      e.preventDefault();
      leeren();
    }
  });
  knopf.onclick = leeren;
  zeigen();
}

leerenVerdrahten("q", () => {
  el("searchResult").className = "result";
  el("searchResult").innerHTML = "";
});
leerenVerdrahten("invQ", () => {
  ["invResultWrap", "invChartWrap", "invClusterWrap", "invEventsWrap", "invFlowWrap"]
    .forEach((id) => { if (el(id)) el(id).style.display = "none"; });
  el("invHead").innerHTML = "";
  CUR_WALLET = null;
  el("invTipps").hidden = false;
  if (el("page-investigate").classList.contains("on")) adresseSetzen("/investigate", false);
});
el("invTipps").addEventListener("click", (e) => {
  const b = e.target.closest("[data-addr]");
  if (b) investigateAddress(b.dataset.addr);
});
leerenVerdrahten("lbSearch", () => {
  el("lbSearchMsg").style.display = "none";
  el("lbSearchMsg").textContent = "";
});

// Alte Links mit "#migration" haben Vorrang, sonst entscheidet der Pfad.
const startZiel = LADER[location.hash.slice(1)]
  ? { seite: location.hash.slice(1) }
  : seiteAusPfad(location.pathname);
const start = startZiel.seite ?? "overview";
/* ---------- Willkommen -----------------------------------------------------
 *
 * Einmal je Browser. Der Grund ist handfest: der Stern an einer Wallet-Zeile
 * erklaert sich nicht von selbst - wer nicht weiss, dass es die Merkliste
 * gibt, druckt ihn nie. Ein Panel beim ersten Besuch sagt es einmal und
 * verschwindet dann fuer immer.
 *
 * Ueber die Adresszeile mit "?intro" wieder hervorzuholen, damit man es sich
 * ansehen kann, ohne die Seitendaten des Browsers loeschen zu muessen.
 */
const WILLKOMMEN_KEY = "etnr_willkommen";

function willkommenPruefen() {
  let gesehen = false;
  try {
    gesehen = localStorage.getItem(WILLKOMMEN_KEY) === "1";
  } catch {
    gesehen = true; // keine Seitendaten - dann lieber nicht bei jedem Aufruf
  }
  if (gesehen && !new URLSearchParams(location.search).has("intro")) return;
  el("welcome").hidden = false;
  // Der Vermerk wird bewusst NUR beim Klick auf das X gesetzt, nicht schon
  // nach ein paar Sekunden oder beim ersten Klick irgendwo. Wer die
  // Begruessung nicht selbst weggedrueckt hat, soll sie wiedersehen - sie
  // erklaert, wofuer die Seite ueberhaupt da ist, und das einmal zu oft zu
  // zeigen ist der kleinere Fehler.
}

/* ---------- Rueckmeldung ---------------------------------------------------
 *
 * Der Honigtopf (#fbHp) liegt ausserhalb des Bildschirms und wird von keinem
 * Menschen ausgefuellt. Ist er gefuellt, meldet der Server trotzdem Erfolg -
 * eine Fehlermeldung wuerde nur verraten, dass die Falle bemerkt wurde.
 *
 * Fuer den Betreiber zeigt derselbe Dialog unten den Posteingang. Zwei
 * getrennte Oberflaechen dafuer waeren doppelte Arbeit fuer denselben Inhalt.
 */
function fbOeffnen() {
  el("fbModal").classList.add("on");
  el("fbStatus").textContent = "";
  el("fbText").focus();
  if (ADMIN.token) fbPosteingang();
}

function fbSchliessen() {
  el("fbModal").classList.remove("on");
}

/**
 * Besucherzahlen - nur fuer den Betreiber, im selben Dialog wie der
 * Posteingang.
 *
 * "Leute" sind verschiedene Tageshashes, nicht Seitenaufrufe: Wer dreimal am
 * Tag vorbeischaut, zaehlt einmal. Die Dauer ist AKTIVE Zeit - ein Tab, der
 * im Hintergrund liegt, laeuft nicht mit.
 */
/* Besucher - nur fuer den Betreiber.
 *
 * Vier Kacheln, ein Chart, zwei Ranglisten. Klicks und "Regulars" sind raus:
 * die Klickzahl sagte nichts, und "Regulars" (seit sieben Tagen dabei) stand
 * wochenlang auf 0 %. */
const VIS = { tage: "14", daten: null };
const VIS_ZEITRAEUME = [{ k: "7", t: "7D" }, { k: "14", t: "14D" }, { k: "30", t: "30D" }];
// neu/wieder fuer den Chart, seiten/herkunft je eine Liste. Blau und Tuerkis
// sind am 15.09.2026 als Paar gegen --card geprueft (bestanden).
const VIS_FARBE = { neu: "#4a8df2", wieder: "#d9752a", seiten: "#4a8df2", herkunft: "#1aa887" };
// Name und Icon wie in der Navigation.
const VIS_SEITEN = {
  overview: ["Overview", "🌊"], migration: ["Migration", "🌉"], tiers: ["Tiers", "🏔️"],
  board: ["Leaderboard", "🏆"], activity: ["Activity", "⚡"], chain: ["Chain", "⛓️"],
  investigate: ["Investigate", "🔎"], about: ["About", "📡"], clusters: ["Clusters", "🔍"],
  whatif: ["What if", "🧮"], images: ["Images", "🖼️"],
};
const VIS_QUELLE_ICON = { X: "𝕏", Facebook: "📘", Google: "🔎", Telegram: "✈️", Reddit: "👽", "Direct / app": "🔗" };

const visDauer = (s) => {
  const n = Math.round(Number(s) || 0);
  return n >= 60 ? Math.floor(n / 60) + "m " + (n % 60) + "s" : n + "s";
};

// Dieselbe Quelle unter verschiedenen Namen zusammenfassen: t.co ist X,
// l./lm./m.facebook.com sind alle Facebook. Die eigene Seite ist keine Herkunft.
function visHerkunftName(h) {
  const x = String(h).toLowerCase();
  if (x === "t.co" || x === "x.com" || x.endsWith("twitter.com")) return "X";
  if (x.endsWith("facebook.com")) return "Facebook";
  if (/(^|\.)google\./.test(x)) return "Google";
  if (x === "t.me" || x.endsWith("telegram.org")) return "Telegram";
  if (x.endsWith("reddit.com")) return "Reddit";
  if (x === location.hostname) return null;
  return h;
}

// Rangliste: Icon, Name, Zahl mit Anteil an allen Besuchen, darunter der
// Balken auf einer Spur. Die Balkenlaenge misst am groessten Eintrag.
function visBalken(eintraege, farbe, besuche) {
  if (!eintraege.length) return '<div class="dim3" style="font-size:12px;padding:8px 0">No data yet.</div>';
  const max = Math.max(1, ...eintraege.map((e) => e.n));
  return eintraege.map((e) =>
    '<div class="visbar"><span class="ic">' + esc(e.ic ?? "🌐") + '</span>' +
    '<span class="nm">' + esc(e.name) + '</span>' +
    '<span class="n num">' + nf(e.n) + (besuche ? "<small>" + nf((e.n / besuche) * 100, 0) + "%</small>" : "") + "</span>" +
    '<span class="spur"><i style="width:' + ((e.n / max) * 100).toFixed(1) + "%;background:" + farbe + '"></i></span></div>'
  ).join("");
}

async function fbBesucher() {
  if (!ADMIN.token) return;
  let d;
  try {
    d = await hole("/api/besuche?tage=" + VIS.tage);
  } catch {
    return; /* kein Zugriff - dann bleiben die Zahlen eben zu */
  }
  VIS.daten = d;
  el("visStats").hidden = false;
  periodTabs(el("visTabs"), VIS.tage, (k) => { VIS.tage = k; fbBesucher(); }, VIS_ZEITRAEUME);

  const g = d.gesamt ?? {};
  const anteil = (teil, ganz) => (!ganz || teil == null ? "—" : nf((teil / ganz) * 100, 0) + "%");
  const kachel = (k, w, s) =>
    '<div class="vistile"><span class="k">' + k + '</span><span class="w">' + w + '</span><span class="s">' + s + "</span></div>";
  el("visTiles").innerHTML =
    kachel("People", nf(g.leute ?? 0), nf(g.besuche ?? 0) + " visits") +
    // Anteil an den Personen je Tag: sagt, ob die Seite benutzt oder nur
    // einmal angeklickt wird.
    kachel("Returning", anteil(g.wieder, g.leute_tage), "of daily visitors") +
    kachel("Avg. time", visDauer(g.dauer), "per visit") +
    kachel("On mobile", anteil(g.mobil, g.besuche), "of visits");

  el("visSeiten").innerHTML = visBalken(
    (d.bereiche ?? []).slice(0, 8).map((b) => ({ name: VIS_SEITEN[b.name]?.[0] ?? b.name, ic: VIS_SEITEN[b.name]?.[1], n: b.n })),
    VIS_FARBE.seiten,
    g.besuche
  );

  const quellen = {};
  for (const h of d.herkunft ?? []) {
    const name = visHerkunftName(h.herkunft);
    if (name) quellen[name] = (quellen[name] ?? 0) + h.n;
  }
  if (g.direkt) quellen["Direct / app"] = g.direkt;
  el("visHerkunft").innerHTML = visBalken(
    Object.entries(quellen).map(([name, n]) => ({ name, n, ic: VIS_QUELLE_ICON[name] }))
      .sort((a, b) => b.n - a.n).slice(0, 7),
    VIS_FARBE.herkunft,
    g.besuche
  );

  zeichneBesucherChart();
}

// Leute je Tag als Saeulen: unten die Wiederkehrer, oben die Neuen. Tage ohne
// Besuch sind eine 0, keine Luecke.
function zeichneBesucherChart() {
  const d = VIS.daten;
  const holder = el("visHolder");
  if (!d || holder.clientWidth === 0) return;
  const svg = el("visChart");
  const tip = el("visTip");

  const n = Number(d.zeitraum_tage) || 14;
  const proTag = Object.fromEntries((d.pro_tag ?? []).map((t) => [t.tag, t]));
  const reihe = [];
  for (let i = n - 1; i >= 0; i--) {
    const tag = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const t = proTag[tag];
    const leute = t?.leute ?? 0;
    const wieder = Math.min(leute, t?.wieder ?? 0);
    reihe.push({ tag, leute, wieder, neu: leute - wieder, besuche: t?.besuche ?? 0, dauer: t?.dauer ?? null });
  }

  const W = Math.max(320, Math.round(holder.clientWidth));
  const H = W < 640 ? 170 : 210;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.style.height = H + "px";
  const PT = 10, PB = 26, PL = 34, PR = 4;
  const hoehe = H - PT - PB;

  // Glatte Achsenwerte: 0 / 10 / 20 statt 0 / 14 / 28.
  const max = Math.max(1, ...reihe.map((r) => r.leute));
  const roh = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(roh)));
  const schritt = Math.max(1, [1, 2, 5, 10].map((f) => f * p).find((s) => s >= roh));
  const hi = Math.ceil(max / schritt) * schritt;

  const slot = (W - PL - PR) / reihe.length;
  const breite = Math.min(24, slot * 0.62);
  const X = (i) => PL + i * slot + (slot - breite) / 2;
  const hoeheVon = (v) => (v / hi) * hoehe;
  const basis = H - PB;

  // Rechteck mit 4px runder Oberkante, unten eckig auf der Grundlinie.
  const saeule = (x, oben, h, farbe, rund) => {
    if (h <= 0) return "";
    const r = rund ? Math.min(4, h, breite / 2) : 0;
    return '<path fill="' + farbe + '" d="M' + x.toFixed(1) + " " + (oben + h).toFixed(1) +
      "V" + (oben + r).toFixed(1) + (r ? "Q" + x.toFixed(1) + " " + oben.toFixed(1) + " " + (x + r).toFixed(1) + " " + oben.toFixed(1) : "") +
      "H" + (x + breite - r).toFixed(1) +
      (r ? "Q" + (x + breite).toFixed(1) + " " + oben.toFixed(1) + " " + (x + breite).toFixed(1) + " " + (oben + r).toFixed(1) : "") +
      "V" + (oben + h).toFixed(1) + 'Z"/>';
  };

  let gitter = "";
  for (let v = 0; v <= hi; v += schritt) {
    const y = basis - hoeheVon(v);
    gitter += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) +
      '" stroke="#1e293b" stroke-width="1"/>' +
      '<text x="' + (PL - 7) + '" y="' + (y + 4).toFixed(1) + '" fill="#7d8ba3" font-size="11" text-anchor="end" ' +
      'font-family="ui-monospace,monospace">' + nf(v) + "</text>";
  }

  const jede = Math.max(1, Math.ceil(reihe.length / Math.max(2, Math.floor((W - PL - PR) / 58))));
  const datum = (tag) => new Date(tag + "T00:00:00Z").toLocaleDateString(LOC, { month: "short", day: "numeric", timeZone: "UTC" });
  let achse = "";
  reihe.forEach((r, i) => {
    if ((reihe.length - 1 - i) % jede) return; // vom heutigen Tag aus zaehlen, damit er beschriftet ist
    achse += '<text x="' + (X(i) + breite / 2).toFixed(1) + '" y="' + (H - 8) + '" fill="#7d8ba3" font-size="11" ' +
      'text-anchor="middle" font-family="ui-monospace,monospace">' + (i === reihe.length - 1 ? "today" : datum(r.tag)) + "</text>";
  });

  let saeulen = "";
  reihe.forEach((r, i) => {
    const hW = hoeheVon(r.wieder);
    const hN = hoeheVon(r.neu);
    // 2px Luecke zwischen den Segmenten, von der oberen Haelfte genommen.
    const luecke = hW > 0 && hN > 0 ? Math.min(2, hN / 2) : 0;
    saeulen += saeule(X(i), basis - hW, hW, VIS_FARBE.wieder, hN <= 0);
    saeulen += saeule(X(i), basis - hW - hN, hN - luecke, VIS_FARBE.neu, true);
  });

  svg.innerHTML = gitter +
    '<rect class="hl" x="0" y="' + PT + '" width="' + slot.toFixed(1) + '" height="' + hoehe + '" fill="#ffffff" opacity="0"/>' +
    saeulen + achse;

  const hl = svg.querySelector(".hl");
  const zeile = (farbe, text) => {
    const s = document.createElement("span");
    if (farbe) {
      const k = document.createElement("i");
      k.className = "vistipkey";
      k.style.background = farbe;
      s.appendChild(k);
    }
    s.appendChild(document.createTextNode(text));
    return s;
  };
  holder.onmousemove = (e) => {
    const box = holder.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const i = Math.floor((x - PL) / slot);
    if (i < 0 || i >= reihe.length) { tip.classList.remove("on"); hl.setAttribute("opacity", "0"); return; }
    const r = reihe[i];
    hl.setAttribute("x", (PL + i * slot).toFixed(1));
    hl.setAttribute("opacity", ".04");
    const wert = document.createElement("b");
    wert.textContent = nf(r.leute) + (r.leute === 1 ? " person" : " people");
    tip.replaceChildren(
      wert,
      zeile(VIS_FARBE.neu, nf(r.neu) + " new"),
      zeile(VIS_FARBE.wieder, nf(r.wieder) + " returning"),
      zeile(null, nf(r.besuche) + " visits" + (r.dauer != null ? " · " + visDauer(r.dauer) + " avg" : "")),
      zeile(null, i === reihe.length - 1 ? "today" : datum(r.tag))
    );
    tip.classList.add("on");
    const b = tip.getBoundingClientRect();
    const px = ((X(i) + breite / 2) / W) * box.width;
    let links = px + 12;
    if (links + b.width > box.width) links = Math.max(0, px - b.width - 12);
    tip.style.left = links + "px";
    tip.style.right = "auto";
    tip.style.top = "4px";
  };
  holder.onmouseleave = () => { tip.classList.remove("on"); hl.setAttribute("opacity", "0"); };
}

/* Neues Feedback: der Feedback-Knopf leuchtet beim Betreiber gruen, bis er den
 * Posteingang oeffnet. "Gesehen" ist die hoechste Nummer beim letzten Oeffnen,
 * gemerkt in seinem Browser. Gefragt wird nur nach dieser einen Nummer - eine
 * Zeile, nicht der ganze Posteingang. */
const FB_GESEHEN_KEY = "etnFbGesehen";

function fbGesehen(id) {
  try { localStorage.setItem(FB_GESEHEN_KEY, String(id)); } catch { /* privater Modus */ }
  document.querySelector("#nav [data-feedback]")?.classList.remove("fbneu");
}

async function fbNeuPruefen() {
  if (!ADMIN.token || document.hidden) return;
  try {
    const d = await hole("/api/feedback/neu");
    let gesehen = 0;
    try { gesehen = Number(localStorage.getItem(FB_GESEHEN_KEY)) || 0; } catch { /* privater Modus */ }
    document.querySelector("#nav [data-feedback]")?.classList.toggle("fbneu", d.neuste_id > gesehen);
  } catch {
    /* kein Zugriff oder Netz weg - dann eben kein Leuchten */
  }
}

async function fbPosteingang() {
  try {
    const d = await hole("/api/feedback");
    // Die Liste kommt neueste zuerst - was jetzt da ist, gilt als gesehen.
    fbGesehen(d.eintraege?.[0]?.id ?? 0);
    const box = el("fbInbox");
    box.hidden = false;
    el("fbListe").innerHTML = d.eintraege?.length
      ? d.eintraege
          .map(
            (e) =>
              '<div class="fbeintrag" data-fb="' + e.id + '">' +
              '<button class="fbdel" data-del="' + e.id + '" title="Delete">&times;</button>' +
              '<span class="wer">' +
              new Date(e.ts).toLocaleString(LOC) +
              (e.absender ? " · " + esc(e.absender) : "") +
              (e.seite ? " · " + esc(e.seite) : "") +
              "</span>" + esc(e.nachricht) + "</div>"
          )
          .join("")
      : '<div class="dim3" style="font-size:12.5px">Nothing yet.</div>';
  } catch {
    /* kein Zugriff - dann bleibt der Posteingang eben zu */
  }
}

// Loeschen: Der Knopf ist nur im Posteingang sichtbar, und den sieht nur der
// Betreiber. Geprueft wird trotzdem serverseitig - ein versteckter Knopf ist
// keine Sperre, den Aufruf koennte sonst jeder von Hand schicken.
el("fbListe").onclick = async (ev) => {
  const b = ev.target.closest("[data-del]");
  if (!b) return;
  const zeile = b.closest(".fbeintrag");
  zeile.style.opacity = ".4";
  try {
    const r = await fetch("/api/feedback/" + b.dataset.del, {
      method: "DELETE",
      headers: adminKopf(),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    zeile.remove();
    if (!el("fbListe").children.length) {
      el("fbListe").innerHTML = '<div class="dim3" style="font-size:12.5px">Nothing yet.</div>';
    }
  } catch {
    zeile.style.opacity = "1";
    el("fbStatus").textContent = "Could not delete.";
  }
};

async function fbSenden() {
  const nachricht = el("fbText").value.trim();
  const status = el("fbStatus");
  if (!nachricht) {
    status.textContent = "Please write something first.";
    status.style.color = "var(--warn)";
    return;
  }
  el("fbSend").disabled = true;
  status.textContent = "Sending…";
  status.style.color = "var(--tx3)";
  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nachricht,
        absender: el("fbName").value.trim(),
        seite: document.querySelector("#nav button.on")?.dataset.p ?? "",
        hp: el("fbHp").value,
      }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error ?? "Could not send.");
    el("fbText").value = "";
    status.textContent = "Thanks - that landed. 🙏";
    status.style.color = "var(--up)";
  } catch (e) {
    status.textContent = e.message;
    status.style.color = "var(--down)";
  } finally {
    el("fbSend").disabled = false;
  }
}

el("fbSend").onclick = fbSenden;
el("fbClose").onclick = fbSchliessen;
el("fbModal").onclick = (e) => { if (e.target.id === "fbModal") fbSchliessen(); };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && el("fbModal").classList.contains("on")) fbSchliessen();
});
document.querySelectorAll("[data-feedback]").forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); fbOeffnen(); };
});

/* ---------- Spenden ---------------------------------------------------------
 *
 * Unsichtbar, solange im Worker keine Adresse hinterlegt ist (DONATE_ADDRESS
 * in wrangler.toml). Die Adresse kommt mit der Uebersicht, wie der Name des
 * Telegram-Bots - so aendert sie sich an einer Stelle, nicht in zwei Dateien.
 */
let SPENDE_ADRESSE = null;

function spendeEinblenden(adr) {
  SPENDE_ADRESSE = /^0x[0-9a-fA-F]{40}$/.test(String(adr ?? "")) ? adr : null;
  document.querySelectorAll("[data-spende]").forEach((b) => { b.hidden = !SPENDE_ADRESSE; });
}
function spendeOeffnen() {
  if (!SPENDE_ADRESSE) return;
  el("spendeAdr").textContent = SPENDE_ADRESSE;
  el("spendeStatus").textContent = "";
  el("spendeModal").classList.add("on");
}
const spendeSchliessen = () => el("spendeModal").classList.remove("on");

document.querySelectorAll("[data-spende]").forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); spendeOeffnen(); };
});
el("spendeClose").onclick = spendeSchliessen;
el("spendeModal").addEventListener("click", (e) => {
  if (e.target === el("spendeModal")) spendeSchliessen();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && el("spendeModal").classList.contains("on")) spendeSchliessen();
});
el("spendeCopy").onclick = async () => {
  const st = el("spendeStatus");
  try {
    await navigator.clipboard.writeText(SPENDE_ADRESSE);
    st.textContent = "Copied - thank you! 💛";
    st.style.color = "var(--acc2)";
  } catch {
    st.textContent = "Copying is blocked in this browser - select the address above instead.";
    st.style.color = "var(--warn)";
  }
};
el("spendeLink").onclick = () => window.open(EXPLORER + SPENDE_ADRESSE, "_blank", "noopener");

el("welcomeClose").onclick = () => {
  el("welcome").hidden = true;
  try {
    localStorage.setItem(WILLKOMMEN_KEY, "1");
  } catch {
    /* egal */
  }
};

el("copyYear").textContent = new Date().getFullYear();

willkommenPruefen();

/* ---------- Besuchszaehlung ---------------------------------------------
 *
 * Sammelt waehrend des Besuchs und meldet beim Verlassen EINMAL eine
 * Zusammenfassung: wie lange, wie viele Klicks, welche Reiter. Nicht jeder
 * Klick einzeln - das waeren Zehntausende Schreibvorgaenge am Tag statt
 * einiger hundert.
 *
 * Gezaehlt wird nur, wer sich wirklich bewegt hat. Ein Crawler laedt die
 * Seite und bewegt nichts; er faellt damit von selbst heraus, ohne dass
 * jemand eine Bot-Liste pflegen muesste. Dasselbe gilt fuer automatische
 * Pruefabrufe.
 *
 * Gemessen wird AKTIVE Zeit: Ein Tab, der stundenlang im Hintergrund liegt,
 * zaehlt nicht weiter. Sonst haette ein vergessenes Fenster die
 * Durchschnittsdauer jeder Auswertung ruiniert.
 *
 * Es wird nichts im Geraet gespeichert - kein Cookie, keine Kennung. Wer
 * jemand ist, interessiert hier nicht; nur wie viele es sind.
 */
const ZAEHLER = {
  start: Date.now(),
  aktivSeit: document.hidden ? null : Date.now(),
  aktiveMs: 0,
  klicks: 0,
  bereiche: new Set(),
  bewegt: false,
  gesendet: false,
};

["mousedown", "keydown", "touchstart", "scroll", "wheel"].forEach((art) =>
  addEventListener(art, () => { ZAEHLER.bewegt = true; }, { passive: true, once: true })
);
addEventListener("click", () => { ZAEHLER.klicks++; ZAEHLER.bewegt = true; }, { passive: true });

// Aktive Zeit mitzaehlen: laeuft nur, solange der Tab sichtbar ist.
function zaehlerPausieren() {
  if (ZAEHLER.aktivSeit != null) {
    ZAEHLER.aktiveMs += Date.now() - ZAEHLER.aktivSeit;
    ZAEHLER.aktivSeit = null;
  }
}
addEventListener("visibilitychange", () => {
  if (document.hidden) zaehlerPausieren();
  else if (ZAEHLER.aktivSeit == null) ZAEHLER.aktivSeit = Date.now();
});

/**
 * Der Tag des ersten Besuchs dieses Geraets, als "JJJJ-MM-TT".
 *
 * Das ist KEINE Kennung. An einem Tag tragen hunderte Geraete denselben Wert;
 * zwei Besuche lassen sich darueber nicht miteinander verbinden, und wer
 * jemand ist, steht darin ohnehin nicht. Er beantwortet genau eine Frage -
 * "war dieses Geraet schon an einem frueheren Tag hier" - und keine weitere.
 *
 * Bewusst NICHT der Willkommen-Vermerk, obwohl der schon im Geraet liegt: der
 * wird nur gesetzt, wenn jemand die Begruessung mit dem X wegdrueckt, und das
 * tut auf dem Handy fast niemand. Als Beleg fuer "schon mal da gewesen" waere
 * er damit systematisch zu niedrig - eine Zahl, die nach Messung aussieht und
 * keine ist.
 *
 * Wer seine Seitendaten loescht oder ein anderes Geraet nimmt, gilt wieder als
 * neu. Die Zahl untertreibt also eher, als dass sie uebertreibt.
 */
const ERST_KEY = "etnr_erst";
function erstbesuchTag() {
  const heute = new Date().toISOString().slice(0, 10);
  try {
    const da = localStorage.getItem(ERST_KEY);
    if (da) return da;
    localStorage.setItem(ERST_KEY, heute);
  } catch {
    return null; // privater Modus - dann zaehlt der Besuch eben ohne Vorgeschichte
  }
  return heute;
}

function besuchSenden() {
  if (ZAEHLER.gesendet || !ZAEHLER.bewegt) return;
  // Der Betreiber ist kein Besucher. Wer sich mit dem Admin-Wort angemeldet
  // hat, sieht sich seine eigene Seite an - das gehoert nicht in eine
  // Statistik ueber deren Nutzung. Ohne diese Zeile misst man am Ende vor
  // allem sich selbst.
  if (ADMIN.token) return;
  ZAEHLER.gesendet = true;
  zaehlerPausieren();
  const daten = {
    dauer_s: Math.round(ZAEHLER.aktiveMs / 1000),
    klicks: ZAEHLER.klicks,
    erst: erstbesuchTag(),
    bereiche: [...ZAEHLER.bereiche].join(","),
    einstieg: start || "overview",
    herkunft: document.referrer || "",
    mobil: matchMedia("(max-width: 760px)").matches,
  };
  try {
    // sendBeacon ueberlebt das Schliessen des Tabs - ein normales fetch wird
    // an dieser Stelle haeufig abgebrochen.
    const nutzlast = new Blob([JSON.stringify(daten)], { type: "application/json" });
    if (!navigator.sendBeacon || !navigator.sendBeacon("/api/besuch", nutzlast)) {
      fetch("/api/besuch", { method: "POST", body: JSON.stringify(daten), keepalive: true });
    }
  } catch {
    /* Zaehlen ist Beiwerk - es darf nie stoeren */
  }
}

// pagehide ist der zuverlaessige Zeitpunkt; visibilitychange faengt zusaetzlich
// den Fall ab, dass ein Handy-Browser den Tab wegraeumt, ohne pagehide zu
// schicken.
addEventListener("pagehide", besuchSenden);
addEventListener("visibilitychange", () => { if (document.hidden) besuchSenden(); });

// Die Seite bleibt bei vielen offen liegen. Ohne diesen Takt bliebe "snapshot
// 3 min ago" stundenlang stehen, obwohl nichts mehr nachkommt.
// (bekannteSnapshotId steht oben bei SNAPSHOT_MARKE - beide gehoeren zusammen.)

/**
 * Nachladen, wenn es wirklich etwas Neues gibt.
 *
 * Die Seite bleibt bei vielen offen liegen. Bisher wurde nur der Text
 * "snapshot 3 min ago" fortgeschrieben, waehrend die Zahlen darunter ewig
 * stehenblieben - nach zwei Stunden schaute man auf zwei Stunden alte Daten.
 *
 * Gefragt wird ein winziger Endpunkt, der nur den Zeitstempel liefert; erst
 * wenn der sich aendert, wird wirklich neu geladen. Wuerde die Seite im Takt
 * alles neu ziehen, kostete jeder offene Tab zehn Abfragen pro Minute.
 * Versteckte Tabs fragen gar nicht.
 */
async function pruefeNeueDaten() {
  if (document.hidden) return;
  try {
    const s = await hole("/api/stand");
    if (!s.snapshot_id) return;
    if (bekannteSnapshotId == null) {
      bekannteSnapshotId = s.snapshot_id;
      return;
    }
    if (s.snapshot_id === bekannteSnapshotId) return;
    bekannteSnapshotId = s.snapshot_id;
    // Ohne das hier holte der Takt gleich wieder die alte Adresse.
    SNAPSHOT_MARKE = s.snapshot_id;

    // Alle Bereiche als ungeladen markieren, aber nur den sichtbaren jetzt
    // holen - der Rest laedt beim Hinwechseln.
    const aktuell = document.querySelector("#nav button.on")?.dataset.p;
    geladen.clear();
    uebersichtLaeuft = null;
    if (aktuell && LADER[aktuell]) {
      geladen.add(aktuell);
      await LADER[aktuell]();
    }
  } catch {
    /* Netz weg, Endpunkt stumm: beim naechsten Takt noch einmal */
  }
}

setInterval(() => {
  if (letzterBekannterSnapshot) {
    el("snapTime").textContent = "snapshot " + zeitHer(letzterBekannterSnapshot) + " ago";
    pruefeFrische();
  }
  pruefeNeueDaten();
  fbNeuPruefen();
}, 60000);

if (startZiel.wallet) investigateAddress(startZiel.wallet, false);
else zeigeSeite(LADER[start] ? start : "overview", false);
// Kopfzeile (Snapshot-Zeit, Preis) soll auch dann stimmen, wenn man per
// Deep-Link auf einem anderen Reiter startet. Wichtig: den VOLLEN Loader
// aufrufen, nicht nur ladeOverview() - sonst gilt "overview" als geladen,
// waehrend Teile davon (Bridge-Ereignisse, Job-Status) nie liefen und
// beim spaeteren Wechsel dorthin ewig auf "Loading..." stehen blieben.
if (start !== "overview" && LADER[start]) {
  geladen.add("overview");
  LADER.overview().catch(console.error);
}
fbNeuPruefen();

// ---------- Wal-Alarm ----------
//
// Wer wiederkommt, sieht in einer kleinen Karte, welche grossen Bewegungen es
// seit dem letzten Besuch gab (/api/whales, fuer alle dieselbe Antwort). Der
// letzte Besuch liegt nur im eigenen Browser; beim ersten Besuch kommt nichts.
const WAL_BESUCH_KEY = "etnWalBesuch";

function walText(e) {
  const wer = "<b>" + (e.anzeige ? esc(e.anzeige) : (e.tier_emoji ? e.tier_emoji + " " : "") + kurzAdr(e.address)) + "</b>";
  const betrag = '<b class="num">' + kurz(Math.abs(e.delta_etn)) + " ETN</b>";
  if (e.type === "sleeper_wake") return ["😴", wer + " woke up · " + (e.delta_etn < 0 ? "moved out " : "received ") + betrag];
  // Bei einer Boerse klaenge "emptied" nach Pleite - dort ist es meist ein Umzug.
  if (e.type === "drained" && e.label_type !== "exchange") return ["🚨", wer + " was emptied · " + betrag + " out"];
  if (e.delta_etn > 0) return ["🐳", wer + " received " + betrag];
  return ["🐳", wer + " moved out " + betrag];
}

async function walAlarm() {
  // Der Stand rollt nur nach einer echten Pause weiter: wer alle zwanzig
  // Minuten neu laedt, verpasst sonst jede Meldung.
  let letzter = null;
  try {
    letzter = localStorage.getItem(WAL_BESUCH_KEY);
    if (letzter && Date.now() - Date.parse(letzter) < BESUCH_PAUSE_MS) return;
    localStorage.setItem(WAL_BESUCH_KEY, new Date().toISOString());
  } catch {
    return;
  }
  if (!letzter) return;
  const d = await hole("/api/whales").catch(() => null);
  const neu = (d?.eintraege ?? []).filter((e) => e.detected_at > letzter);
  if (!neu.length) return;

  const karte = document.createElement("div");
  karte.className = "walalarm";
  karte.setAttribute("role", "dialog");
  karte.setAttribute("aria-label", "Big moves since your last visit");
  karte.innerHTML =
    '<div class="walkopf"><b>🐳 Since your last visit</b>' +
    '<button type="button" class="ghost walzu" aria-label="Close">✕</button></div>' +
    neu.slice(0, 4).map((e) => {
      const [ic, text] = walText(e);
      return '<a class="walzeile" href="/wallet/' + esc(e.address) + '" data-wallet="' + esc(e.address) + '">' +
        "<i>" + ic + "</i><span>" + text + '</span><em class="dim3">' + zeitHer(e.detected_at) + " ago</em></a>";
    }).join("") +
    '<a class="walmehr" href="/activity" data-seite="activity">' +
      (neu.length > 4 ? "+ " + (neu.length - 4) + " more · " : "") + "All events in Activity →</a>";
  document.body.appendChild(karte);

  karte.addEventListener("click", (ev) => {
    if (ev.target.closest(".walzu")) return karte.remove();
    const w = ev.target.closest("a[data-wallet]");
    const s = ev.target.closest("a[data-seite]");
    if ((!w && !s) || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault();
    karte.remove();
    if (w) investigateAddress(w.dataset.wallet);
    else zeigeSeite(s.dataset.seite);
  });
}
walAlarm().catch(() => {});
