// Lokaler Entwicklungsserver: laesst src/index.js (den Worker) unveraendert
// gegen die lokale SQLite-Datei laufen. Dadurch sind API und Dashboard
// vollstaendig testbar, ohne irgendetwas zu Cloudflare hochzuladen.
//
//   node scripts/serve-local.mjs [port] [dbPfad]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { LocalDB } from "./local-db.mjs";
import worker from "../src/index.js";

const port = Number(process.argv[2] ?? 8787);
const dbPath = process.argv[3] ?? "./data/etn.db";
const PUBLIC = new URL("../public/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const db = new LocalDB(dbPath);

const TYPEN = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// env.ASSETS wie bei Workers Static Assets
const ASSETS = {
  async fetch(request) {
    const u = new URL(request.url);
    let p = decodeURIComponent(u.pathname);
    if (p === "/" || p.endsWith("/")) p += "index.html";
    // Pfad-Ausbrueche verhindern
    const datei = join(PUBLIC, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    try {
      const inhalt = await readFile(datei);
      return new Response(inhalt, {
        headers: { "content-type": TYPEN[extname(datei)] ?? "application/octet-stream" },
      });
    } catch {
      try {
        return new Response(await readFile(join(PUBLIC, "index.html")), {
          headers: { "content-type": TYPEN[".html"] },
        });
      } catch {
        return new Response("public/index.html fehlt noch", { status: 404 });
      }
    }
  },
};

// caches.default ist im Worker vorhanden - lokal als No-op nachbilden.
globalThis.caches = {
  default: { async match() { return undefined; }, async put() {} },
};

// Alles ueberschreibbar, damit auch die optionalen Teile lokal testbar sind:
//   ADMIN_TOKEN=geheim node scripts/serve-local.mjs
//   -> danach http://localhost:8787/?admin=geheim aufrufen
const env = {
  DB: db,
  ASSETS,
  EXPLORER_API: process.env.EXPLORER_API ?? "https://blockexplorer.electroneum.com/api/v2",
  TRACK_TOP_N: process.env.TRACK_TOP_N ?? "3000",
  MIGRATION_DEADLINE: process.env.MIGRATION_DEADLINE ?? "2027-01-31",
  BRIDGE_ADDRESS: process.env.BRIDGE_ADDRESS ?? "0xB7990022d3F22B6FB3afb626E05289ee3bf0AE62",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

createServer(async (req, res) => {
  const url = "http://" + (req.headers.host ?? "localhost:" + port) + req.url;
  const t0 = Date.now();
  try {
    // Header UND Body weiterreichen: ohne das laesst sich weder der
    // Admin-Token-Header noch der Telegram-Webhook (POST mit JSON) lokal
    // pruefen - beides sah dann faelschlich nach "funktioniert nicht" aus.
    const rumpf = [];
    if (req.method !== "GET" && req.method !== "HEAD") {
      for await (const stueck of req) rumpf.push(stueck);
    }
    const anfrage = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: rumpf.length ? Buffer.concat(rumpf) : undefined,
    });
    const antwort = await worker.fetch(anfrage, env, ctx);
    const buf = Buffer.from(await antwort.arrayBuffer());
    res.writeHead(antwort.status, Object.fromEntries(antwort.headers));
    res.end(buf);
    console.log(
      String(antwort.status) + "  " + req.method + " " + req.url +
        "  " + (Date.now() - t0) + "ms  " + buf.length + "B"
    );
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    console.error("500 " + req.url + "  " + e.message);
  }
}).listen(port, () => {
  console.log("Dashboard:  http://localhost:" + port + "/");
  console.log("API:        http://localhost:" + port + "/api/overview");
  console.log("Datenbank:  " + dbPath + "\n");
});
