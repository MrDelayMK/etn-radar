// Bridge-Durchgang mit Explorer-Aussetzer mitten im Haeppchen: nichts darf
// verloren gehen oder doppelt zaehlen, und der Lauf muss weitermachen.
import { repoUrl, frischeDb, pruefer, BRIDGE } from "./hilfen.mjs";

const { runBridgeEventAnalysis } = await import(repoUrl("src/bridge-events.js"));
const { pruef, ende } = pruefer();

// Ein Transfer alle fuenf Minuten = 288 je Tag, 30 Seiten ab 03.01.2026 zurueck.
const SEITEN = 30, JE_SEITE = 50, SCHRITT_MS = 300000;
const START = Date.parse("2026-01-03T00:00:00Z");
// Seite 15 liegt mitten im 31.12.2025 und scheitert fuenfmal - so oft, bis
// getJson aufgibt und der Durchgang pausieren muss.
const KAPUTT_SEITE = 15, KAPUTT_MAL = 5;

let kaputt = 0;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith("/internal-transactions")) {
    const seite = Number(u.searchParams.get("page") ?? 1);
    if (seite === KAPUTT_SEITE && kaputt < KAPUTT_MAL) {
      kaputt++;
      return new Response("bad gateway", { status: 502 });
    }
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
  return new Response(JSON.stringify({ hash: BRIDGE, coin_balance: "1000000" + "0".repeat(18) }),
    { headers: { "content-type": "application/json" } });
};

const db = await frischeDb("scanfehler");
const env = { DB: db, EXPLORER_API: "https://fake.test/api/v2", BRIDGE_ADDRESS: BRIDGE };
const protokoll = [];
const r = await runBridgeEventAnalysis(env, db, { fehlerPauseMs: 1000, log: (m) => protokoll.push(m) });

const summe = await db.prepare("SELECT sum(abfluss_anzahl) n FROM bridge_tage").first();
const tag = async (d) => (await db.prepare("SELECT abfluss_anzahl n FROM bridge_tage WHERE day = ?").bind(d).first())?.n;
pruef(r.historie_vollstaendig === true, "trotz Aussetzer bis zum Ende gelesen");
pruef(r.seiten === SEITEN, "jede Seite genau einmal gezaehlt (" + r.seiten + " von " + SEITEN + ")");
pruef(summe.n === SEITEN * JE_SEITE, "alle " + SEITEN * JE_SEITE + " Transfers in den Tagessummen (" + summe.n + ")");
pruef((await tag("2025-12-31")) === 288, "31.12.2025 vollstaendig, obwohl der Aussetzer mitten darin lag");
pruef((await tag("2026-01-03")) === 1 && (await tag("2025-12-28")) === 59, "Randtage stimmen (03.01.: 1, 28.12.: 59)");
pruef(protokoll.some((z) => z.includes("Pause, dann weiter")), "Pause im Protokoll");
pruef(!protokoll.some((z) => z.includes("Abbruch nach")), "kein Abbruch");

ende();
