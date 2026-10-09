// Wächter: springt ein, wenn GitHub den Zeitplan auslässt.
//
// Der Snapshot läuft als GitHub Action alle 30 Minuten (7,37 * * * *). Geplante
// Workflows sind bei GitHub aber "best effort": bei Last werden Termine
// verschoben oder ersatzlos gestrichen. Am 03.10.2026 kamen so statt 48 nur 24
// Läufe, mit Lücken bis 7,6 Stunden - die Seite sah alt aus, obwohl nichts
// kaputt war.
//
// Darum ruft Cloudflare diesen Worker selbst nach Zeitplan auf (wrangler.toml,
// [triggers]). Er liest nur eine Zeile aus D1 und stößt den Workflow nach, wenn
// der letzte Snapshot zu alt ist. Das erzeugt KEINE zusätzlichen Läufe über den
// 30-Minuten-Takt hinaus - es holt nur nach, was ohnehin stattfinden sollte,
// und belastet den Explorer damit nicht stärker als geplant.

// Ab wann gilt ein Snapshot als ueberfaellig.
//
// Die Schwelle und der Zeitplan des Waechters haengen zusammen: angestossen
// wird beim ersten Aufruf NACH Ablauf der Schwelle. Mit 45 Minuten Schwelle
// und einem Aufruf alle 15 Minuten fiel das auf den Aufruf bei 59 Minuten -
// die Seite stand damit dauerhaft auf einem Stundentakt statt auf 30 Minuten.
// Mit 28 Minuten Schwelle und einem Aufruf alle 10 Minuten greift es bei 29
// Minuten, also genau im gewollten Takt. Mehr Laeufe als die geplanten 48 am
// Tag entstehen dadurch nicht - der Explorer sieht dieselbe Last wie vorgesehen.
export const SNAPSHOT_ALT_MS = 28 * 60 * 1000;
// Nach einem Anstoss Ruhe: der Lauf selbst braucht ein bis zwei Minuten, und
// ein gescheiterter Lauf soll nicht sofort den naechsten nach sich ziehen.
export const WAECHTER_SPERRE_MS = 15 * 60 * 1000;
const NAME = "snapshot_waechter";

/**
 * Prüft das Alter des letzten Snapshots und stößt bei Bedarf snapshot.yml an.
 * Gibt immer ein Ergebnis zurück statt zu werfen - ein Wächter, der den Worker
 * umbringt, wäre schlimmer als ein alter Snapshot.
 */
export async function snapshotWaechter(db, env, jetzt = Date.now()) {
  const snap = await db
    .prepare("SELECT taken_at FROM snapshots ORDER BY id DESC LIMIT 1")
    .first()
    .catch(() => null);
  const alter = snap?.taken_at ? jetzt - Date.parse(snap.taken_at) : Infinity;
  const alterMin = Number.isFinite(alter) ? Math.round(alter / 60000) : null;
  if (alter < SNAPSHOT_ALT_MS) return { ok: true, grund: "frisch", alter_min: alterMin };

  const sperre = await db
    .prepare("SELECT last_triggered_at FROM job_control WHERE name = ?")
    .bind(NAME)
    .first()
    .catch(() => null);
  const seitAnstoss = sperre?.last_triggered_at ? jetzt - Date.parse(sperre.last_triggered_at) : Infinity;
  if (seitAnstoss < WAECHTER_SPERRE_MS) {
    return { ok: true, grund: "sperre", alter_min: alterMin, wartet_noch_min: Math.round((WAECHTER_SPERRE_MS - seitAnstoss) / 60000) };
  }

  if (!env.GITHUB_PAT || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    return { ok: false, grund: "nicht_konfiguriert", alter_min: alterMin };
  }

  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/snapshot.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.GITHUB_PAT,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "etn-radar-worker",
      },
      body: JSON.stringify({ ref: env.GITHUB_BRANCH ?? "main" }),
    }
  ).catch((e) => ({ status: 0, fehler: String(e) }));

  if (res.status !== 204) {
    const text = res.text ? await res.text().catch(() => "") : (res.fehler ?? "");
    return { ok: false, grund: "github_fehler", status: res.status, alter_min: alterMin, details: String(text).slice(0, 200) };
  }

  // Sperre erst nach dem erfolgreichen Anstoß setzen: ein abgelehnter Versuch
  // darf den nächsten nicht blockieren.
  await db
    .prepare(
      "INSERT INTO job_control (name, last_triggered_at) VALUES (?, ?)" +
        " ON CONFLICT(name) DO UPDATE SET last_triggered_at = excluded.last_triggered_at"
    )
    .bind(NAME, new Date(jetzt).toISOString())
    .run()
    .catch(() => {});

  return { ok: true, grund: "angestossen", alter_min: alterMin };
}
