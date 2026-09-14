// Bridge-Durchgang ueber die ganze Historie mit Pause-Stand, Anzeige ab
// HISTORIE_AB und Top-Liste - gegen einen nachgebauten Explorer.
import { repoUrl, frischeDb, pruefer, ctx, BRIDGE, ohneZwischenspeicher } from "./hilfen.mjs";

const { runBridgeEventAnalysis } = await import(repoUrl("src/bridge-events.js"));
const worker = (await import(repoUrl("src/index.js"))).default;
const { pruef, ende } = pruefer();
ohneZwischenspeicher();

const bridge = BRIDGE.toLowerCase();
// Ein Transfer alle fuenf Minuten = 288 je Tag. 45 Seiten reichen vom
// 06.01.2026 knapp acht Tage zurueck - also sicher ueber den Jahreswechsel.
const SEITEN = 45, JE_SEITE = 50, SCHRITT_MS = 300000, JE_TAG = 288;
const START = Date.parse("2026-01-06T00:00:00Z");

let anfragen = 0;
let letzteSeite = 0;
globalThis.fetch = async (url) => {
  anfragen++;
  const u = new URL(String(url));
  if (u.pathname.endsWith("/internal-transactions")) {
    const seite = Number(u.searchParams.get("page") ?? 1);
    letzteSeite = seite;
    const items = Array.from({ length: JE_SEITE }, (_, j) => {
      const k = (seite - 1) * JE_SEITE + j;
      return {
        transaction_hash: "0x" + k.toString(16).padStart(64, "0"),
        type: "call",
        from: { hash: BRIDGE }, to: { hash: "0x1111111111111111111111111111111111111111" },
        value: "1000000000000000000", success: true,
        timestamp: new Date(START - k * SCHRITT_MS).toISOString(),
      };
    });
    return new Response(JSON.stringify({ items, next_page_params: seite < SEITEN ? { page: seite + 1 } : null }),
      { headers: { "content-type": "application/json" } });
  }
  if (u.pathname.toLowerCase().endsWith("/addresses/" + bridge)) {
    return new Response(JSON.stringify({ hash: BRIDGE, coin_balance: "1000000" + "0".repeat(18) }),
      { headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};

const db = await frischeDb("bridge-historie");
const env = { DB: db, EXPLORER_API: "https://fake.test/api/v2", BRIDGE_ADDRESS: BRIDGE, MIGRATION_DEADLINE: "2027-01-31" };
const tag = async (d) => (await db.prepare("SELECT abfluss_anzahl n FROM bridge_tage WHERE day = ?").bind(d).first())?.n;
const scan = () => db.prepare("SELECT fertig, cursor, aeltestes_bekannt FROM bridge_scan WHERE id = 1").first();
const hol = async (pfad) => (await worker.fetch(new Request("http://localhost" + pfad), env, ctx)).json();

// --- Pause-Stand: fertig=1, aber noch ein Cursor (so stand es am 11.09.2026) ---
await runBridgeEventAnalysis(env, db, { budgetMinuten: 0.05, log: () => {} });
const s0 = await scan();
await db.prepare("UPDATE bridge_scan SET fertig = 1 WHERE id = 1").run();
pruef(s0.cursor != null, "kurzer Vorlauf hinterlaesst einen Cursor");

anfragen = 0;
const r1 = await runBridgeEventAnalysis(env, db, { log: () => {} });
const s1 = await scan();
pruef(r1.seiten > 1, "ein Pause-Stand liest weiter statt nur oben nachzusehen");
pruef(letzteSeite === SEITEN, "bis zur letzten Seite gelesen");
pruef(r1.historie_vollstaendig === true && s1.fertig === 1 && s1.cursor == null, "am Ende fertig und ohne Cursor");
pruef((await tag("2026-01-01")) === JE_TAG, "01.01.2026 vollstaendig gezaehlt");
pruef((await tag("2025-12-31")) === JE_TAG, "31.12.2025 ebenfalls geschrieben - gesammelt wird alles");

// --- Danach nur noch der Blick nach oben ----------------------------------
anfragen = 0;
await runBridgeEventAnalysis(env, db, { log: () => {} });
pruef(anfragen <= 3, "ein fertiger Durchgang kostet hoechstens 3 Anfragen (" + anfragen + ")");
pruef((await tag("2026-01-06")) === 1, "06.01.2026 nicht doppelt gezaehlt");

// --- Anzeige: Chart ab 31.12.2025, auch wenn aeltere Tage vorliegen --------
const v = await hol("/api/bridge-verlauf");
const p = v.punkte ?? [];
pruef(v.vollstaendig === true, "Verlauf vollstaendig");
pruef(p[0]?.day === "2025-12-31", "Chart beginnt am 31.12.2025 (" + p[0]?.day + ")");
pruef(Math.round(p[0]?.etn) === 1000000 + 5 * JE_TAG + 1, "Startbestand = Anker + Abfluesse seit Jahresbeginn");
pruef(Math.round(p[p.length - 1]?.etn) === 1000000, "Endpunkt = Anker");
const alles = await hol("/api/bridge-verlauf?period=all");
pruef(alles.punkte?.[0]?.day < "2025-12-31", "All beginnt vor dem Jahreswechsel");

// --- Top-Liste: vollstaendig erst ohne Cursor ------------------------------
pruef((await hol("/api/bilanz")).transfers_vollstaendig === true, "Liste vollstaendig, wenn fertig und ohne Cursor");
await db.prepare("UPDATE bridge_scan SET cursor = '{\"page\":2}' WHERE id = 1").run();
pruef((await hol("/api/bilanz")).transfers_vollstaendig === false, "Liste nicht vollstaendig, solange ein Cursor steht");

ende();
