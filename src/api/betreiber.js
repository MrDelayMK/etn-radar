// Betreiber-Bereich: Feedback, Besuchszaehlung und die Knoepfe fuer Hintergrund-Jobs.

import { json, zahlParam, tagVor } from "./grundlagen.js";

/* ---------- Rueckmeldungen ----------------------------------------------
 *
 * Drei Bremsen gegen Missbrauch, alle ohne Konto und ohne Captcha:
 *
 *   Honigtopf   Ein Feld, das niemand sieht und darum niemand ausfuellt.
 *               Ist es gefuellt, tun wir so, als haette es geklappt - eine
 *               Fehlermeldung wuerde dem Absender nur verraten, dass wir es
 *               gemerkt haben.
 *   Rate        Fuenf Nachrichten je Stunde und Absender.
 *   Laenge      Zugeschnitten, statt beliebig viel zu speichern.
 */
const FEEDBACK_MAX_LAENGE = 1200;
const FEEDBACK_MAX_ABSENDER = 60;
const FEEDBACK_PRO_STUNDE = 5;

/** Kurzer Hash aus IP und Tag - reicht zum Bremsen, taugt nicht zum Erkennen. */
async function absenderHash(request) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unbekannt";
  const roh = new TextEncoder().encode(ip + "|" + new Date().toISOString().slice(0, 10));
  const digest = await crypto.subtle.digest("SHA-256", roh);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function feedbackSenden(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ungueltige Anfrage." }, 400, 0);
  }

  if (body.hp) return json({ ok: true }, 200, 0); // Honigtopf

  const nachricht = String(body.nachricht ?? "").trim().slice(0, FEEDBACK_MAX_LAENGE);
  const absender = String(body.absender ?? "").trim().slice(0, FEEDBACK_MAX_ABSENDER) || null;
  const seite = String(body.seite ?? "").trim().slice(0, 40) || null;
  if (!nachricht) return json({ error: "Die Nachricht ist leer." }, 400, 0);

  const hash = await absenderHash(request);
  const seitEinerStunde = new Date(Date.now() - 3600000).toISOString();
  const bisher = await db
    .prepare("SELECT count(*) n FROM feedback WHERE ip_hash = ? AND ts >= ?")
    .bind(hash, seitEinerStunde)
    .first();
  if ((bisher?.n ?? 0) >= FEEDBACK_PRO_STUNDE) {
    return json({ error: "Zu viele Nachrichten in kurzer Zeit. Bitte spaeter noch einmal." }, 429, 0);
  }

  await db
    .prepare("INSERT INTO feedback (ts, nachricht, absender, seite, ip_hash) VALUES (?,?,?,?,?)")
    .bind(new Date().toISOString(), nachricht, absender, seite, hash)
    .run();

  return json({ ok: true }, 200, 0);
}

/* ---------- Besuchszaehlung --------------------------------------------
 *
 * Zaehlt, wie viele verschiedene Menschen die Seite benutzen, wie lange sie
 * bleiben und wie viel sie klicken. Bewusst selbst gebaut statt mit einem
 * fremden Dienst: kein Konto, keine laufenden Kosten, keine Daten bei Dritten.
 *
 * EINE Zeile je BESUCH, nicht je Klick. Der Browser sammelt waehrend des
 * Besuchs und meldet beim Verlassen einmal die Zusammenfassung. Bei tausend
 * Besuchern taeglich sind das tausend geschriebene Zeilen; je Klick waeren es
 * Zehntausende, und das Gratis-Schreibbudget sind 100.000 am Tag.
 *
 * WER GEZAEHLT WIRD: nur wer sich wirklich bewegt hat - Maus, Tastatur,
 * Scrollen, Beruehrung. Crawler fuehren entweder kein JavaScript aus oder
 * bewegen nichts, und sie fallen damit heraus, ohne dass irgendjemand eine
 * Bot-Liste pflegen muesste. Auch die eigenen Pruefabrufe zaehlen nicht mit:
 * die bewegen nie eine Maus.
 *
 * WER NICHT ERKENNBAR WIRD: "besucher" ist ein kurzer Hash aus IP UND TAG. Er
 * wechselt jede Nacht, laesst sich nicht zurueckrechnen und folgt niemandem
 * ueber Tage. Kein Cookie, kein localStorage, keine Kennung im Geraet - es
 * gibt also nichts, wofuer eine Einwilligung einzuholen waere. Er reicht
 * genau fuer "wie viele verschiedene Leute waren heute da" und fuer nichts
 * darueber hinaus. Dasselbe Verfahren bremst schon das Feedback-Formular.
 */
const BESUCH_MAX_DAUER = 4 * 3600; // laenger ist ein vergessener Tab, kein Besuch
const BESUCH_MAX_KLICKS = 2000;
const BESUCH_PRO_STUNDE = 30; // Bremse gegen erfundene Zahlen
// Frueher kann kein Erstbesuch liegen - die Zaehlung gibt es seit dem
// 08.09.2026. Ein Datum davor ist entweder eine falsch gestellte Uhr oder
// jemand, der am Wert gedreht hat.
const BESUCH_START = "2026-09-08";

export async function besuchMelden(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: true }, 200, 0); // nie mit Fehlern um sich werfen
  }

  const zahl = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const dauer = zahl(body.dauer_s, BESUCH_MAX_DAUER);
  const klicks = zahl(body.klicks, BESUCH_MAX_KLICKS);
  // Unter drei Sekunden ohne einen einzigen Klick ist kein Besuch, sondern
  // ein Blick und ein Zurueck.
  if (dauer < 3 && klicks === 0) return json({ ok: true }, 200, 0);

  const sauber = (v, n) =>
    String(v ?? "").trim().slice(0, n).replace(/[^a-zA-Z0-9 ,.:\/-]/g, "") || null;

  const hash = await absenderHash(request);
  const jetzt = new Date();
  const seitEinerStunde = new Date(jetzt.getTime() - 3600000).toISOString();
  const bisher = await db
    .prepare("SELECT count(*) n FROM besuche WHERE besucher = ? AND ts >= ?")
    .bind(hash, seitEinerStunde)
    .first();
  if ((bisher?.n ?? 0) >= BESUCH_PRO_STUNDE) return json({ ok: true }, 200, 0);

  // Erstbesuch dieses Geraets, taggenau. Geprueft statt uebernommen: der Wert
  // kommt aus dem Browser und koennte alles sein. Alles ausserhalb des
  // plausiblen Fensters - Zukunft, oder aelter als die Seite selbst - wird
  // verworfen statt gebogen, sonst stuenden erfundene Daten in der Statistik.
  let erst = null;
  {
    const roh = String(body.erst ?? "");
    const heute = new Date().toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(roh) && roh >= BESUCH_START && roh <= heute) erst = roh;
  }

  // Nur die Domain, nie der volle Verweis: Der Pfad einer fremden Seite kann
  // verraten, wonach jemand gesucht hat.
  let herkunft = null;
  try {
    const r = String(body.herkunft ?? "");
    if (r) herkunft = new URL(r).hostname.replace(/^www\./, "").slice(0, 60);
  } catch {
    herkunft = null;
  }

  // Der Schreibvorgang darf den Besucher NIE erreichen. Faellt er aus - fehlende
  // Spalte nach einem Deploy vor der Migration, erschoepftes Schreibkontingent,
  // was auch immer - ist die Zaehlung fuer diesen Besuch verloren und sonst
  // nichts. Ein 500 auf dem Weg nach draussen waere der teuerste denkbare Preis
  // fuer eine Statistik.
  try {
  await db
    .prepare(
      "INSERT INTO besuche (ts, tag, besucher, dauer_s, klicks, bereiche, einstieg," +
        " herkunft, geraet, erstbesuch) VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(
      jetzt.toISOString(),
      jetzt.toISOString().slice(0, 10),
      hash,
      dauer,
      klicks,
      sauber(body.bereiche, 120),
      sauber(body.einstieg, 20),
      herkunft,
      body.mobil ? "mobil" : "desktop",
      erst
    )
    .run();
  } catch {
    /* siehe oben - Zaehlen ist Beiwerk */
  }

  return json({ ok: true }, 200, 0);
}

/** Auswertung - nur fuer den Betreiber. */
export async function besucheLesen(db, u) {
  const tage = zahlParam(u, "tage", 14, 1, 90);
  // Heute mitgezaehlt: "14 Tage" sind heute und die 13 davor, nicht 15.
  const abTag = tagVor(tage - 1);

  const [proTag, gesamt, bereiche, herkunft] = await Promise.all([
    db
      .prepare(
        // Alles je Tag, alles in derselben Einheit: LEUTE. Die Gesamtwerte
        // entstehen daraus durch Addition (siehe unten) - damit steht in der
        // Kachel nie etwas, das sich nicht aus der Tagesliste nachrechnen
        // laesst. "besuche" zaehlt daneben jeden einzelnen Aufruf, auch den
        // dritten am selben Tag.
        "SELECT tag, count(DISTINCT besucher) leute, count(*) besuche," +
          " sum(klicks) klicks, avg(dauer_s) dauer," +
          " count(DISTINCT CASE WHEN erstbesuch < tag THEN besucher END) wieder," +
          " count(DISTINCT CASE WHEN julianday(tag) - julianday(erstbesuch) >= 7" +
          "   THEN besucher END) stamm" +
          " FROM besuche WHERE tag >= ? GROUP BY tag ORDER BY tag DESC"
      )
      .bind(abTag)
      .all(),
    db
      .prepare(
        "SELECT count(DISTINCT besucher) leute, count(*) besuche, sum(klicks) klicks," +
          " avg(dauer_s) dauer, sum(CASE WHEN geraet='mobil' THEN 1 ELSE 0 END) mobil," +
          // Ohne Herkunft: Link getippt, aus einem Lesezeichen oder aus einer
          // App, die keinen Verweis mitschickt.
          " sum(CASE WHEN herkunft IS NULL THEN 1 ELSE 0 END) direkt" +
          " FROM besuche WHERE tag >= ?"
      )
      .bind(abTag)
      .first(),
    db
      .prepare("SELECT bereiche FROM besuche WHERE tag >= ? AND bereiche IS NOT NULL LIMIT 2000")
      .bind(abTag)
      .all(),
    db
      .prepare(
        "SELECT herkunft, count(*) n FROM besuche WHERE tag >= ? AND herkunft IS NOT NULL" +
          " GROUP BY herkunft ORDER BY n DESC LIMIT 25"
      )
      .bind(abTag)
      .all(),
  ]);

  // Reiter zaehlen: steht als kommagetrennte Liste je Besuch, hier
  // zusammengezaehlt - dafuer lohnt keine eigene Tabelle.
  const proBereich = {};
  for (const z of bereiche.results ?? []) {
    for (const b of String(z.bereiche).split(",")) {
      const k = b.trim();
      if (k) proBereich[k] = (proBereich[k] ?? 0) + 1;
    }
  }

  // Die Wiederkehr-Summen werden addiert statt neu abgefragt: so kann die
  // Kachel gar nicht etwas anderes sagen als die Tagesliste darunter.
  const tageReihe = proTag.results ?? [];
  const summe = (feld) => tageReihe.reduce((n, t) => n + (t[feld] ?? 0), 0);

  return {
    zeitraum_tage: tage,
    gesamt: gesamt
      ? {
          ...gesamt,
          leute_tage: summe("leute"), // Personen je Tag, ueber alle Tage addiert
          wieder: summe("wieder"),
          stamm: summe("stamm"),
        }
      : null,
    pro_tag: tageReihe,
    bereiche: Object.entries(proBereich)
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n),
    herkunft: herkunft.results ?? [],
  };
}

/** Posteingang - nur fuer den Betreiber. */
export async function feedbackLesen(db) {
  const rows = (
    await db
      .prepare("SELECT id, ts, nachricht, absender, seite FROM feedback ORDER BY id DESC LIMIT 100")
      .all()
  ).results;
  return { eintraege: rows };
}

// ---------------------------------------------------------------------------
// Manuelle Trigger fuer lange Hintergrund-Jobs ("Run now"-Knoepfe)
//
// Der Worker kann weder die Tiefenzaehlung noch die Cluster-Analyse selbst
// ausfuehren (10 ms CPU-Limit, beide Laeufe dauern 15-30 Minuten). Ein Knopf
// loest stattdessen den passenden GitHub-Actions-Workflow per API aus. Eine
// 24h-Sperre PRO JOB verhindert, dass Klicks den Explorer wiederholt mit
// einem vollen Lauf belasten - sie wird erst NACH einem erfolgreichen
// Ausloesen gesetzt, damit ein Konfigurationsfehler (fehlendes Secret o.ae.)
// nicht gleich einen ganzen Tag blockiert.
// ---------------------------------------------------------------------------
const TRIGGER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const JOBS = {
  census: { workflow: "census.yml", runsTable: "census_runs" },
  clusters: { workflow: "clusters.yml", runsTable: "cluster_runs" },
  exchanges: { workflow: "exchange-detect.yml", runsTable: "exchange_detect_runs" },
  // Der Bridge-Durchgang arbeitet sich ueber mehrere Laeufe durch die
  // Historie und setzt jedes Mal dort fort, wo er aufgehoert hat. Mit der
  // gleichen 24-Stunden-Sperre wie die anderen Jobs braeuchte das Wochen -
  // und ein fehlgeschlagener Lauf verbrennt den Versuch fuer den ganzen Tag.
  // Drei Stunden sind gegenueber dem Explorer immer noch zurueckhaltend.
  bridge: { workflow: "bridge-events.yml", runsTable: "bridge_event_runs", sperreMs: 3 * 3600000 },
};

export async function job_status(db, name) {
  const job = JOBS[name];
  const row = await db.prepare("SELECT last_triggered_at FROM job_control WHERE name=?").bind(name).first();
  const letzterLauf = await db
    .prepare(`SELECT taken_at, status FROM ${job.runsTable} ORDER BY id DESC LIMIT 1`)
    .first();
  const letzterTrigger = row?.last_triggered_at ?? null;
  const rest = letzterTrigger
    ? (job.sperreMs ?? TRIGGER_COOLDOWN_MS) - (Date.now() - Date.parse(letzterTrigger))
    : 0;
  return {
    letzter_trigger: letzterTrigger,
    letzter_lauf: letzterLauf ?? null,
    bereit: rest <= 0,
    wartezeit_ms: Math.max(0, rest),
  };
}

export async function job_trigger(db, env, name) {
  const job = JOBS[name];
  const status = await job_status(db, name);
  if (!status.bereit) return { ok: false, grund: "cooldown", ...status };

  if (!env.GITHUB_PAT || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    return {
      ok: false,
      grund: "nicht_konfiguriert",
      hinweis:
        "GITHUB_PAT/GITHUB_OWNER/GITHUB_REPO sind nicht gesetzt. " +
        "Bis dahin: Actions-Tab -> Run workflow (" + job.workflow + ").",
    };
  }

  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/workflows/${job.workflow}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.GITHUB_PAT,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "etn-radar-worker",
    },
    body: JSON.stringify({ ref: env.GITHUB_BRANCH ?? "main" }),
  });

  if (res.status !== 204) {
    const text = await res.text().catch(() => "");
    return { ok: false, grund: "github_fehler", status: res.status, details: text.slice(0, 300) };
  }

  // Sperre erst nach Erfolg setzen - siehe Begruendung oben.
  const jetzt = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO job_control (name, last_triggered_at) VALUES (?, ?)" +
        " ON CONFLICT(name) DO UPDATE SET last_triggered_at = excluded.last_triggered_at"
    )
    .bind(name, jetzt)
    .run();

  return { ok: true, gestartet_um: jetzt };
}
