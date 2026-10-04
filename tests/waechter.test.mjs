// Waechter (src/waechter.js): holt den Snapshot nach, wenn GitHub seinen
// eigenen Zeitplan auslaesst. Geprueft wird vor allem, WANN er anstoesst -
// zu oft waere zusaetzliche Last beim Explorer, zu selten sieht die Seite alt
// aus. GitHub wird nachgebaut, der Test ruft nie das echte Netz.
import { repoUrl, frischeDb, pruefer } from "./hilfen.mjs";

const db = await frischeDb("waechter");
const { snapshotWaechter, SNAPSHOT_ALT_MS, WAECHTER_SPERRE_MS } = await import(repoUrl("src/waechter.js"));
const { pruef, ende } = pruefer();

const env = { GITHUB_PAT: "ghp_test", GITHUB_OWNER: "MrDelayMK", GITHUB_REPO: "etn-radar" };
let abrufe = [];
let antwort = 204;
globalThis.fetch = async (url, opt) => {
  abrufe.push({ url: String(url), auth: opt?.headers?.Authorization, body: opt?.body });
  return new Response(antwort === 204 ? null : "nope", { status: antwort });
};

const jetzt = Date.parse("2026-10-04T12:00:00Z");
const snapSetzen = (minutenAlt) =>
  db.db.prepare("INSERT OR REPLACE INTO snapshots (taken_at, day, addr_count) VALUES (?,?,?)")
    .run(new Date(jetzt - minutenAlt * 60000).toISOString(), "2026-10-04", 3000);

// Ohne jeden Snapshot: anstossen, sonst bliebe eine frische Datenbank leer.
const leer = await snapshotWaechter(db, env, jetzt);
pruef(leer.ok && leer.grund === "angestossen", "ohne Snapshot wird sofort angestossen");
pruef(abrufe[0].url.endsWith("/actions/workflows/snapshot.yml/dispatches"), "der richtige Workflow wird angestossen");
pruef(abrufe[0].auth === "Bearer ghp_test", "der Schluessel geht als Bearer mit");

// Direkt danach: Sperre.
abrufe = [];
const gleichDanach = await snapshotWaechter(db, env, jetzt + 60000);
pruef(gleichDanach.grund === "sperre" && abrufe.length === 0, "kein zweiter Anstoss in der Sperrzeit");

// Frischer Snapshot: nichts zu tun.
db.db.prepare("DELETE FROM job_control WHERE name = 'snapshot_waechter'").run();
snapSetzen(20);
abrufe = [];
const frisch = await snapshotWaechter(db, env, jetzt);
pruef(frisch.grund === "frisch" && abrufe.length === 0, "ein 20 Minuten alter Snapshot reicht");

// Knapp vor der Grenze bleibt es dabei, knapp danach wird angestossen.
snapSetzen(SNAPSHOT_ALT_MS / 60000 - 2);
pruef((await snapshotWaechter(db, env, jetzt)).grund === "frisch", "zwei Minuten vor der Grenze noch frisch");
snapSetzen(SNAPSHOT_ALT_MS / 60000 + 2);
abrufe = [];
const faellig = await snapshotWaechter(db, env, jetzt);
pruef(faellig.grund === "angestossen" && abrufe.length === 1, "zwei Minuten nach der Grenze wird nachgeholt");

// Nach Ablauf der Sperre darf wieder angestossen werden.
abrufe = [];
const nachSperre = await snapshotWaechter(db, env, jetzt + WAECHTER_SPERRE_MS + 60000);
pruef(nachSperre.grund === "angestossen" && abrufe.length === 1, "nach der Sperre wird erneut nachgeholt");

// GitHub lehnt ab: kein Erfolg melden und die Sperre nicht setzen.
antwort = 403;
abrufe = [];
const fehler = await snapshotWaechter(db, env, jetzt + 3 * WAECHTER_SPERRE_MS);
pruef(!fehler.ok && fehler.grund === "github_fehler" && fehler.status === 403, "ein abgelehnter Anstoss wird als Fehler gemeldet");
const wieder = await snapshotWaechter(db, env, jetzt + 3 * WAECHTER_SPERRE_MS + 1000);
pruef(wieder.grund === "github_fehler", "ein Fehlversuch blockiert den naechsten nicht");

// Ohne Zugangsdaten passiert gar nichts - die Seite laeuft trotzdem weiter.
antwort = 204;
abrufe = [];
const ohne = await snapshotWaechter(db, {}, jetzt + 4 * WAECHTER_SPERRE_MS);
pruef(!ohne.ok && ohne.grund === "nicht_konfiguriert" && abrufe.length === 0, "ohne Schluessel kein Anstoss und kein Absturz");

ende();
