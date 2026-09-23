// Teilen-Seiten /s/<bild>: richtige Vorschau-Tags, Bilder vorhanden,
// unbekannte Adressen landen auf der Startseite.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, repoUrl, ctx, pruefer } from "./hilfen.mjs";

const { SHARE_BILDER, SHARE_SONDER } = await import(repoUrl("src/share.js"));
const { default: worker } = await import(repoUrl("src/index.js"));
const { pruef, ende } = pruefer();

const env = { ASSETS: { fetch: () => new Response("asset") } };
const holen = (pfad) => worker.fetch(new Request("https://etn-radar.galacticsl.com" + pfad), env, ctx);

const r = await holen("/s/whale-funny");
const html = await r.text();
pruef(r.status === 200 && /text\/html/.test(r.headers.get("content-type")), "/s/whale-funny liefert eine HTML-Seite");
pruef(html.includes('property="og:image" content="https://etn-radar.galacticsl.com/assets/share/whale-funny-card.jpg"'), "og:image zeigt auf das Vorschaubild des Satzes");
pruef(html.includes('name="twitter:card" content="summary_large_image"'), "X bekommt die grosse Bildkarte");
pruef(html.includes('property="og:title" content="What&#39;s your tier? Find out on ETN Radar"'), "Titel laedt zum Mitmachen ein, Apostroph maskiert");
pruef(!/og:(title|description)" content="[^"]*didn&#39;t sell/.test(html), "der Satz steht nur im Bild, nicht nochmal in Titel oder Beschreibung");
pruef(html.includes('og:image:alt" content="Whale: relax, I didn&#39;t sell.'), "Bildbeschreibung fuer Screenreader enthaelt den Satz");
pruef(!/http-equiv="refresh"/i.test(html) && html.includes('location.replace("/")'), "Weiterleitung nur per JavaScript, nicht per Meta-Refresh");

const adresse = "0x" + "ab".repeat(20);
const fremdeSeite = await (await holen("/s/whale-funny?w=" + adresse)).text();
pruef(fremdeSeite.includes('location.replace("/wallet/' + adresse + '")'), "fremdes Wallet: Besucher landen direkt beim Wallet");
pruef(fremdeSeite.includes('og:title" content="Look this wallet up on ETN Radar"'), "fremdes Wallet: Titel laedt zum Nachschauen ein");
const fotoSeite = await (await holen("/s/whale-funny?f=foto")).text();
pruef(fotoSeite.includes("whale-funny-card.jpg") && !fotoSeite.includes("square"), "Vorschau ist immer das breite Bild - ein Quadrat schnitte die Karte ab");
const boese = await (await holen("/s/whale-funny?w=%22)%3Balert(1)%2F%2F")).text();
pruef(boese.includes('location.replace("/")') && !boese.includes("alert"), "ungueltiges ?w= wird ignoriert, nichts davon landet im Skript");
const unbekanntFremd = await holen("/s/whale-rocket?w=" + adresse);
pruef(unbekanntFremd.status === 302 && unbekanntFremd.headers.get("location").endsWith("/wallet/" + adresse), "unbekannter Satz mit Wallet leitet zum Wallet");

const mitSchraegstrich = await holen("/s/crab-funny/");
pruef(mitSchraegstrich.status === 200, "Schraegstrich am Ende wird akzeptiert");

const unbekannt = await holen("/s/whale-rocket");
pruef(unbekannt.status === 302 && unbekannt.headers.get("location") === "https://etn-radar.galacticsl.com/", "unbekannter Satz leitet auf die Startseite");

const fremd = await holen("/s/<script>");
pruef(await fremd.text() === "asset", "Adressen ausserhalb des Musters gehen an die statischen Dateien");

for (const id of Object.keys(SHARE_BILDER)) {
  const card = join(REPO, "public/assets/share", id + "-card.jpg");
  const square = join(REPO, "public/assets/share", id + "-square.jpg");
  pruef(existsSync(card) && existsSync(square), id + ": Vorschau- und 1:1-Bild liegen in public/assets/share");
}

// Seite und Worker muessen dieselben Bilder und Saetze kennen - sonst waehlt
// jemand im Dialog einen Satz und die Vorschau zeigt kein oder ein fremdes Bild.
const appJs = readFileSync(join(REPO, "public/app.js"), "utf8");
const liste = appJs.match(/const SHARE_BILDER = new Set\(\[([^\]]*)\]\)/);
const seitenIds = liste ? [...liste[1].matchAll(/"([a-z]+-[a-z]+)"/g)].map((m) => m[1]).sort() : [];
pruef(JSON.stringify(seitenIds) === JSON.stringify(Object.keys(SHARE_BILDER).sort()), "Teilen-Dialog und Worker kennen dieselben Bilder");
for (const [id, satz] of Object.entries(SHARE_BILDER)) {
  const ton = id.split("-")[1];
  pruef(appJs.includes('["' + ton + '", ' + JSON.stringify(satz) + "]"), id + ": derselbe Satz im Dialog wie im Bild");
}

// Wochenrueckblick: vier Bilder, eines je Art von Nachricht.
const woche = await (await holen("/s/week-whale")).text();
pruef(woche.includes('property="og:image" content="https://etn-radar.galacticsl.com/assets/share/week-whale-card.jpg"'), "Wochenrueckblick: og:image zeigt auf das Wochenbild");
pruef(woche.includes('og:title" content="This week on Electroneum - the full recap on ETN Radar"'), "Wochenrueckblick: eigener Titel");
pruef(woche.includes('location.replace("/")'), "Wochenrueckblick: Besucher landen in der Overview");
for (const id of Object.keys(SHARE_SONDER)) {
  const card = join(REPO, "public/assets/share", id + "-card.jpg");
  const square = join(REPO, "public/assets/share", id + "-square.jpg");
  pruef(existsSync(card) && existsSync(square), id + ": Vorschau- und 1:1-Bild liegen in public/assets/share");
  pruef(appJs.includes('"' + id + '"'), id + ": die Seite kann dieses Bild auch waehlen");
}

// What if: drei Bilder, Besucher landen im Reiter.
const wi = await (await holen("/s/whatif-napkin")).text();
pruef(wi.includes("assets/share/whatif-napkin-card.jpg") && wi.includes('location.replace("/whatif")'), "What if: eigenes Bild, Besucher landen im Reiter");
pruef(wi.includes('og:title" content="What would one ETN cost? Do the math on ETN Radar"'), "What if: eigener Titel");
const reiter = await holen("/whatif");
pruef(await reiter.text() === "asset", "/whatif liefert die Seite aus");

// Bilder-Reiter: jede Kachel braucht ihr kleines Vorschaubild.
const ohneThumb = [...Object.keys(SHARE_BILDER), ...Object.keys(SHARE_SONDER), "banner"]
  .filter((id) => !existsSync(join(REPO, "public/assets/share", id + "-thumb.jpg")));
pruef(ohneThumb.length === 0, "Galerie: alle Vorschaubilder vorhanden" + (ohneThumb.length ? " - fehlt: " + ohneThumb.join(", ") : ""));
const galerie = appJs.match(/const GAL_SONDER = \[([\s\S]*?)\n\];/);
const galIds = galerie ? [...galerie[1].matchAll(/"((?:week|whatif|price)-[a-z]+)"/g)].map((m) => m[1]).sort() : [];
pruef(JSON.stringify(galIds) === JSON.stringify(Object.keys(SHARE_SONDER).sort()), "Galerie zeigt genau die Sonderbilder, die es gibt");
pruef((await holen("/images")).status === 200, "/images liefert die Seite aus");

const start = readFileSync(join(REPO, "public/index.html"), "utf8");
const banner = start.match(/property="og:image" content="https:\/\/etn-radar\.galacticsl\.com(\/assets\/[^"]+)"/);
pruef(banner && existsSync(join(REPO, "public", banner[1])), "Startseite: og:image zeigt auf eine vorhandene Datei");
pruef(start.includes('name="twitter:card" content="summary_large_image"'), "Startseite: grosse Bildkarte fuer X");

ende();
