// Cloudflare Worker: liefert das Dashboard und die JSON-API.
//
// Der Worker LIEST nur. Das Einsammeln der Daten macht die GitHub Action
// (siehe .github/workflows/snapshot.yml), weil Workers Free nur 10 ms CPU pro
// Ausfuehrung erlaubt - fuer tausende Adressen zu wenig. Lesende Abfragen
// bleiben dagegen weit darunter, weil die Wartezeit auf D1 nicht als CPU zaehlt.
//
// Die Endpunkte selbst stehen nach Themen in src/api/ - hier nur die Verteilung.

import { handleTelegramWebhook } from "./telegram.js";
import { stand, overview, preisverlauf, tierVerlauf, network } from "./api/uebersicht.js";
import { json, fehler, adminOk, cacheSchluessel, liveAntwort, notlaufSchreiben, notlaufLesen } from "./api/grundlagen.js";
import { leaderboard, movers, sleepers, watchlist, events, wallet, clusters_api, exchange_flow, wallet_flows, suche } from "./api/wallets.js";
import { feedbackSenden, besuchMelden, besucheLesen, feedbackLesen, job_status, job_trigger } from "./api/betreiber.js";
import { bridgeVerlauf, bilanz, migrationen } from "./api/migration.js";
import { chain } from "./api/chain.js";

// Saubere Seitenadressen (/migration, /leaderboard, /wallet/0x...) sind alle
// dieselbe Seite - welcher Bereich sichtbar ist, entscheidet index.html anhand
// des Pfads.
const SEITEN_PFAD = /^\/(migration|tiers|leaderboard|activity|chain|clusters|investigate|about|wallet\/[^/]+)\/?$/;

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const pfad = u.pathname;

    if (!pfad.startsWith("/api/")) {
      if (SEITEN_PFAD.test(pfad)) return env.ASSETS.fetch(new Request(new URL("/", u), request));
      return env.ASSETS.fetch(request);
    }

    // Trigger/Status der Hintergrund-Jobs niemals cachen: der Knopf muss den
    // aktuellen Sperrzustand sehen, nicht eine bis zu 2 Minuten alte Antwort,
    // und ein POST darf ohnehin nie aus dem Cache beantwortet werden.
    // Telegram-Webhook: nie cachen, kein GET, eigener Erfolgs-Response (immer
    // 200 "ok", damit Telegram nicht endlos wiederholt zustellt).
    if (pfad === "/api/telegram/webhook") {
      if (request.method !== "POST") return new Response("POST erforderlich", { status: 405 });
      return handleTelegramWebhook(request, env, env.DB);
    }

    // Besuch melden: offen (jeder Besucher meldet seinen eigenen), Auswertung
    // nur fuer den Betreiber.
    if (pfad === "/api/besuch") {
      if (request.method !== "POST") return new Response("POST erforderlich", { status: 405 });
      return besuchMelden(request, env.DB);
    }
    if (pfad === "/api/besuche") {
      if (!adminOk(request, env)) {
        return json({ error: "Die Auswertung ist dem Betreiber vorbehalten." }, 403, 0);
      }
      return json(await besucheLesen(env.DB, u), 200, 0);
    }

    // Nur die neueste Nummer - damit der Feedback-Knopf des Betreibers
    // aufleuchten kann, ohne jede Minute den ganzen Posteingang zu lesen.
    if (pfad === "/api/feedback/neu") {
      if (!adminOk(request, env)) {
        return json({ error: "Der Posteingang ist dem Betreiber vorbehalten." }, 403, 0);
      }
      const r = await env.DB.prepare("SELECT max(id) AS id FROM feedback").first();
      return json({ neuste_id: r?.id ?? 0 }, 200, 0);
    }

    if (pfad === "/api/feedback") {
      if (request.method === "POST") return feedbackSenden(request, env.DB);
      if (!adminOk(request, env)) {
        return json({ error: "Der Posteingang ist dem Betreiber vorbehalten." }, 403, 0);
      }
      return json(await feedbackLesen(env.DB), 200, 0);
    }

    // Einzelnen Eintrag loeschen. Den Knopf im Browser zu verstecken reicht
    // nicht - loeschen kann sonst jeder, der die Adresse kennt. Also dieselbe
    // Pruefung wie beim Lesen des Posteingangs.
    const fbMatch = pfad.match(/^\/api\/feedback\/(\d+)$/);
    if (fbMatch) {
      if (request.method !== "DELETE") {
        return new Response("DELETE erforderlich", { status: 405 });
      }
      if (!adminOk(request, env)) {
        return json({ error: "Nur der Betreiber darf loeschen." }, 403, 0);
      }
      await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(Number(fbMatch[1])).run();
      return json({ ok: true }, 200, 0);
    }

    const jobMatch = pfad.match(/^\/api\/(census|clusters|exchanges|bridge)\/(status|trigger)$/);
    if (jobMatch) {
      const [, name, art] = jobMatch;
      try {
        if (art === "status") {
          const s = await job_status(env.DB, name);
          // Das Dashboard blendet die Knoepfe aus, wenn ein Token noetig ist
          // und der Besucher keines hat - besser als ein Knopf, der nur 403 kann.
          return json({ ...s, admin_noetig: !!env.ADMIN_TOKEN, admin_ok: adminOk(request, env) }, 200, 0);
        }
        if (request.method !== "POST") return fehler("POST erforderlich", 405);
        if (!adminOk(request, env)) {
          return json({ ok: false, grund: "kein_zugriff", hinweis: "Dieser Knopf ist dem Betreiber vorbehalten." }, 403, 0);
        }
        const res = await job_trigger(env.DB, env, name);
        return json(res, res.ok ? 200 : 409, 0);
      } catch (e) {
        return json({ error: e.message }, 500, 0);
      }
    }

    // Antworten kurz zwischenspeichern - die Daten aendern sich nur alle 30 Min.
    const cache = caches.default;
    const schluessel = cacheSchluessel(u);
    const schluesselUrl = new URL(schluessel.url);
    const treffer = await cache.match(schluessel);
    if (treffer) return treffer;

    let antwort;
    try {
      const db = env.DB;
      if (pfad === "/api/overview") antwort = json(await overview(db, env));
      else if (pfad === "/api/network") antwort = json(await network(db, env), 200, 120);
      else if (pfad === "/api/price") antwort = json(await preisverlauf(db, env, u), 200, 300);
      else if (pfad === "/api/clusters") antwort = json(await clusters_api(db));
      // Laenger gecacht als der Rest: die Bilanz besteht aus eingefrorenen
      // Werten und einer Wochen-Historie - nichts davon aendert sich in Minuten.
      else if (pfad === "/api/bilanz") antwort = json(await bilanz(db, env), 200, 600);
      // Aendert sich nur mit dem taeglichen Bridge-Durchgang. Eine halbe Stunde,
      // weil die Snapshot-Nummer nicht mehr im Schluessel steckt (cacheSchluessel)
      // - mit sechs Stunden hinge der Chart nach einem Lauf wieder so lange zurueck.
      else if (pfad === "/api/bridge-verlauf") antwort = json(await bridgeVerlauf(db, u), 200, 1800);
      else if (pfad === "/api/migrationen") antwort = json(await migrationen(db, u), 200, 900);
      // Neue Werte kommen hoechstens alle sechs Stunden (Tokens) oder einmal am
      // Tag (Tageswerte) - eine Stunde reicht dicke.
      else if (pfad === "/api/chain") antwort = json(await chain(db, env), 200, 3600);
      // Neue Zeilen kommen einmal am Tag mit dem ersten Snapshot.
      else if (pfad === "/api/tier-verlauf") antwort = json(await tierVerlauf(db), 200, 1800);
      else if (pfad === "/api/leaderboard") antwort = json(await leaderboard(db, env, u));
      else if (pfad === "/api/movers") antwort = json(await movers(db, env, u));
      else if (pfad === "/api/sleepers") antwort = json(await sleepers(db, env, u));
      else if (pfad === "/api/events") antwort = json(await events(db, u));
      else if (pfad === "/api/watchlist") antwort = json(await watchlist(db, env, u), 200, 30);
      else if (pfad === "/api/exchange-flow") antwort = json(await exchange_flow(db, u));
      // Nur der Snapshot-Zeitstempel. Kurz gecacht, damit offene Seiten
      // haeufig nachfragen koennen, ohne die Datenbank zu belasten.
      else if (pfad === "/api/stand") antwort = json(await stand(db), 200, 20);
      else if (pfad === "/api/search") {
        const q = u.searchParams.get("q");
        antwort = q ? liveAntwort(await suche(db, env, q.slice(0, 200))) : fehler("Parameter q fehlt");
      } else if (pfad.startsWith("/api/wallet-flows/")) {
        antwort = liveAntwort(await wallet_flows(db, env, pfad.slice("/api/wallet-flows/".length), u));
      } else if (pfad.startsWith("/api/wallet/")) {
        const w = await wallet(db, env, pfad.slice("/api/wallet/".length));
        antwort = w ? json(w) : fehler("Wallet nicht gefunden", 404);
      } else antwort = fehler("Unbekannter Endpoint", 404);
    } catch (e) {
      // Lieber alte Zahlen mit Datum als eine leere Seite - siehe "Notlauf".
      const ersatz = await notlaufLesen(cache, schluesselUrl);
      if (ersatz) return ersatz;
      antwort = json(
        {
          error: e.message,
          stack: adminOk(request, env) ? String(e.stack).split("\n")[1] : undefined,
        },
        500,
        0
      );
    }

    if (antwort.status === 200) {
      ctx.waitUntil(cache.put(schluessel, antwort.clone()));
      ctx.waitUntil(notlaufSchreiben(cache, schluesselUrl, antwort.clone()));
    }
    return antwort;
  },
};
