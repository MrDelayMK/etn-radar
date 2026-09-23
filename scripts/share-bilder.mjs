// Baut aus den Grok-Rohbildern in Bilder/share-roh/ die Bilder der Seite:
//   public/assets/share/<name>-card.jpg    Link-Vorschau 1200x630: Bild links, Satz rechts
//   public/assets/share/<name>-square.jpg  gerahmtes 1:1-Bild 1080x1080 zum Posten
//   public/assets/share/<name>-thumb.jpg   360x360 fuer die Galerie (Bilder-Reiter)
//   public/assets/share/banner.jpg         Startseite 1200x630 mit Rahmen
//
// Laeuft nur lokal (Windows-Schriften, sharp als devDependency):
//   node scripts/share-bilder.mjs
import sharp from "sharp";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const ROH = REPO + "Bilder/share-roh/";
const AUS = REPO + "public/assets/share/";
const LOGO = REPO + "public/assets/logo-192.png";
const FONTS = "C:/Windows/Fonts/";
const NAVY = "#0d1526";

const TIERS = {
  humpback: ["Humpback Whale", "25M+ ETN", "#a78bfa"],
  whale: ["Whale", "10M+ ETN", "#5b9cff"],
  shark: ["Shark", "5M+ ETN", "#22d3a7"],
  dolphin: ["Dolphin", "2M+ ETN", "#4ade80"],
  fish: ["Fish", "1M+ ETN", "#fbbf24"],
  octopus: ["Octopus", "500K+ ETN", "#fb923c"],
  crab: ["Crab", "200K+ ETN", "#f97316"],
  shrimp: ["Shrimp", "100K+ ETN", "#f4635e"],
  plankton: ["Plankton", "25K+ ETN", "#94a3b8"],
  microbe: ["Microbe", "5K+ ETN", "#64748b"],
  dust: ["Dust", "under 5K ETN", "#7b8aa3"],
};
// Bilder ohne Stufe: Kopfzeile, Unterzeile, Farbe und die Schlagzeile auf der
// Karte. Die Woche wechselt jede Woche, das Bild aber nicht - deshalb steht
// dort die Art der Nachricht und kein Datum.
const SONDER = {
  "week-bridge": ["This week", "Electroneum", "#5b9cff", "Busy week at the migration bridge."],
  "week-whale": ["This week", "Electroneum", "#5b9cff", "A whale made waves this week."],
  "week-busy": ["This week", "Electroneum", "#5b9cff", "Electroneum got busier this week."],
  "week-radar": ["This week", "Electroneum", "#5b9cff", "The week in numbers."],
  "whatif-scale": ["What if", "Market cap", "#fbbf24", "Not a forecast. Just math."],
  "whatif-dream": ["What if", "Market cap", "#fbbf24", "What if ETN were that big?"],
  "whatif-napkin": ["What if", "Market cap", "#fbbf24", "Napkin math for ETN."],
  "price-hype": ["ETN price", "Electroneum", "#22d3a7", "Electroneum is on the move."],
  "price-next": ["ETN price", "Electroneum", "#22d3a7", "Where does ETN go from here?"],
  "price-napkin": ["ETN price", "Electroneum", "#22d3a7", "Napkin math on ETN."],
};
// Die Saetze kommen aus SHARE_SAETZE in public/app.js - so steht auf dem Bild
// immer genau der Satz, den der Teilen-Dialog daneben anbietet.
function saetzeLesen() {
  const js = readFileSync(REPO + "public/app.js", "utf8");
  const von = js.indexOf("const SHARE_SAETZE = {");
  const block = js.slice(von, js.indexOf("const SHARE_TON", von));
  const saetze = {};
  let tier = null;
  for (const zeile of block.split(/\r?\n/)) {
    const t = zeile.match(/^\s{2}([a-z]+):\s*\[\s*$/);
    if (t) { tier = t[1]; continue; }
    const s = zeile.match(/^\s*\["([a-z]+)",\s*"(.*)"\],?\s*$/);
    if (s && tier) saetze[tier + "-" + s[1]] = JSON.parse('"' + s[2] + '"');
  }
  return saetze;
}
const SAETZE = saetzeLesen();

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hell = (hex, anteil = 0.45) => {
  const n = parseInt(hex.slice(1), 16);
  const k = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * anteil));
  return "#" + k.map((c) => c.toString(16).padStart(2, "0")).join("");
};

// knapp = auf die sichtbare Schrift zuschneiden, damit Abstaende links und
// rechts wirklich gleich sind (Pango laesst sonst Luft am Rand).
async function text(markup, font, fontfile, width, knapp = false) {
  let bild = sharp({
    text: { text: markup, font, fontfile: FONTS + fontfile, rgba: true, dpi: 72, ...(width ? { width, wrap: "word" } : {}) },
  }).png();
  if (knapp) bild = sharp(await bild.toBuffer()).trim({ threshold: 1 }).png();
  const { data, info } = await bild.toBuffer({ resolveWithObject: true });
  return { input: data, w: info.width, h: info.height };
}

// Schrift direkt auf dem Bild: darunter liegt eine weichgezeichnete dunkle Kopie,
// damit sie auch auf hellem Sand oder Wasser lesbar bleibt.
async function textMitHalo(inhalt, farbe, font, fontfile) {
  const vorne = await text('<span foreground="' + farbe + '">' + esc(inhalt) + "</span>", font, fontfile, 0, true);
  const dunkel = await text('<span foreground="#020611">' + esc(inhalt) + "</span>", font, fontfile, 0, true);
  const rand = 14;
  const halo = await sharp(dunkel.input)
    .extend({ top: rand, bottom: rand, left: rand, right: rand, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(5).png().toBuffer();
  return { ...vorne, halo, rand };
}

// Rahmen im Electroneum-Stil: die Linie hat oben links eine Luecke fuer das Logo
// und unten rechts eine fuer die Domain. Die Luecken werden per Maske
// ausgespart, damit die Linie zu beiden Seiten weich auslaeuft statt hart zu enden.
async function gerahmt(quelle, W, H, farbe, ziel) {
  const q = W === H;
  const logoS = q ? 64 : 50, i = q ? 46 : 36, r = q ? 30 : 24;
  const luft = q ? 16 : 13;        // freier Platz zwischen Linienende und Inhalt, links wie rechts
  const verlauf = q ? 28 : 22;     // Laenge, auf der die Linie ausblendet
  const zurEcke = q ? 56 : 46;     // Abstand des Inhalts von der Rundung der Ecke
  const abstand = Math.round(logoS * 0.25);
  const logo = await sharp(LOGO).resize(logoS, logoS).toBuffer();
  const name = await textMitHalo("ETN Radar", "#ffffff", "Segoe UI Bold " + (q ? 34 : 27), "segoeuib.ttf");
  const domain = await textMitHalo("etn-radar.galacticsl.com", "#ffffff", "Consolas Bold " + (q ? 22 : 18), "consolab.ttf");

  const obenVon = i + r + zurEcke, obenBis = obenVon + logoS + abstand + name.w;
  const untenBis = W - i - r - zurEcke, untenVon = untenBis - domain.w;

  const luecke = (id, von, bis, y) => {
    const x0 = von - luft - verlauf, x1 = bis + luft + verlauf, w = x1 - x0, f = verlauf / w;
    return {
      verlauf: `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#fff"/><stop offset="${f}" stop-color="#000"/>
        <stop offset="${1 - f}" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>`,
      rechteck: `<rect x="${x0}" y="${y - 30}" width="${w}" height="60" fill="url(#${id})"/>`,
    };
  };
  const oben = luecke("lo", obenVon, obenBis, i);
  const unten = luecke("lu", untenVon, untenBis, H - i);

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="glow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="7"/></filter>
      <filter id="weich" x="-30%" y="-100%" width="160%" height="300%"><feGaussianBlur stdDeviation="16"/></filter>
      ${oben.verlauf}${unten.verlauf}
      <mask id="luecken" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
        <rect width="${W}" height="${H}" fill="#fff"/>${oben.rechteck}${unten.rechteck}
      </mask>
    </defs>
    <rect x="${obenVon - 12}" y="${i - logoS / 2 - 4}" width="${obenBis - obenVon + 24}" height="${logoS + 8}" rx="${logoS / 2}" fill="#06101f" opacity="0.55" filter="url(#weich)"/>
    <rect x="${untenVon - 14}" y="${H - i - domain.h / 2 - 8}" width="${domain.w + 28}" height="${domain.h + 16}" rx="${domain.h / 2}" fill="#06101f" opacity="0.7" filter="url(#weich)"/>
    <g mask="url(#luecken)">
      <rect x="${i}" y="${i}" width="${W - 2 * i}" height="${H - 2 * i}" rx="${r}" fill="none" stroke="${farbe}" stroke-width="8" opacity="0.7" filter="url(#glow)"/>
      <rect x="${i}" y="${i}" width="${W - 2 * i}" height="${H - 2 * i}" rx="${r}" fill="none" stroke="${hell(farbe, 0.35)}" stroke-width="3"/>
    </g>
  </svg>`;

  const nameX = obenVon + logoS + abstand, nameY = Math.round(i - name.h / 2);
  const domY = Math.round(H - i - domain.h / 2);
  await sharp(quelle).resize(W, H, { fit: "cover" })
    .composite([
      { input: Buffer.from(svg), left: 0, top: 0 },
      { input: name.halo, left: nameX - name.rand, top: nameY - name.rand },
      { input: name.input, left: nameX, top: nameY },
      { input: logo, left: obenVon, top: Math.round(i - logoS / 2) },
      { input: domain.halo, left: untenVon - domain.rand, top: domY - domain.rand },
      { input: domain.halo, left: untenVon - domain.rand, top: domY - domain.rand },
      { input: domain.input, left: untenVon, top: domY },
    ])
    .jpeg({ quality: 88, mozjpeg: true }).toFile(ziel);
}

// Link-Vorschau: quadratisches Bild links, Satz rechts
async function karte(quelle, [tierName, ab, farbe], satz, ziel) {
  const W = 1200, H = 630, X = 630, rand = 54;
  const kunst = await sharp(quelle).resize(H, H, { fit: "cover" }).toBuffer();
  const logo = await sharp(LOGO).resize(50, 50).toBuffer();
  const name = await text('<span foreground="#ffffff">ETN Radar</span>', "Segoe UI Bold 27", "segoeuib.ttf");
  const label = await text('<span foreground="' + hell(farbe, 0.4) + '" letter_spacing="2600">' + esc(tierName.toUpperCase() + "  ·  " + ab) + "</span>", "Consolas Bold 19", "consolab.ttf");
  const domain = await text('<span foreground="#8fa3c2">etn-radar.galacticsl.com</span>', "Consolas 18", "consola.ttf");

  const breite = W - X - rand * 2;
  // Zwei Saetze bekommen je eine eigene Zeile: "Relax, I didn't sell." / "I just rolled over..."
  let satzText = satz.charAt(0).toUpperCase() + satz.slice(1);
  const teile = satzText.match(/^(.+?[.?!])\s+(.+)$/);
  if (teile && teile[1].split(" ").length > 1 && teile[2].split(" ").length > 1) satzText = teile[1] + "\n" + teile[2];
  const satzMarkup = '<span foreground="#ffffff">' + esc(satzText) + "</span>";
  let block, groesse;
  for (groesse of [54, 48, 42, 36]) {
    block = await text(satzMarkup, "Segoe UI Semibold " + groesse, "seguisb.ttf", breite);
    if (block.h <= groesse * 1.4 * 3) break; // hoechstens drei Zeilen
  }
  // Ausgewogene Zeilen: so schmal wie moeglich, ohne eine Zeile mehr zu brauchen
  for (let w = breite - 12; w > breite * 0.55; w -= 12) {
    const enger = await text(satzMarkup, "Segoe UI Semibold " + groesse, "seguisb.ttf", w);
    if (enger.h > block.h) break;
    block = enger;
  }
  const blockH = label.h + 22 + block.h;
  const blockY = Math.round((H - blockH) / 2 + 8);

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="g" cx="100%" cy="0%" r="90%"><stop offset="0" stop-color="${farbe}" stop-opacity="0.34"/><stop offset="1" stop-color="${farbe}" stop-opacity="0"/></radialGradient></defs>
    <rect x="${X}" y="0" width="${W - X}" height="${H}" fill="${NAVY}"/>
    <rect x="${X}" y="0" width="${W - X}" height="${H}" fill="url(#g)"/>
    <rect x="${X}" y="0" width="6" height="${H}" fill="${farbe}"/>
  </svg>`;

  await sharp({ create: { width: W, height: H, channels: 3, background: NAVY } })
    .composite([
      { input: kunst, left: 0, top: 0 },
      { input: Buffer.from(svg), left: 0, top: 0 },
      { input: logo, left: X + rand, top: 44 },
      { input: name.input, left: X + rand + 50 + 12, top: Math.round(44 + (50 - name.h) / 2) },
      { input: label.input, left: X + rand, top: blockY },
      { input: block.input, left: X + rand, top: blockY + label.h + 22 },
      { input: domain.input, left: X + rand, top: H - 44 - domain.h },
    ])
    .jpeg({ quality: 88, mozjpeg: true }).toFile(ziel);
}

mkdirSync(AUS, { recursive: true });
const fertig = [];
for (const datei of readdirSync(ROH).sort()) {
  const name = datei.replace(/\.(jpe?g|png|webp)$/i, "");
  const quelle = ROH + datei;
  if (name === "banner") {
    await gerahmt(quelle, 1200, 630, "#8b8cf8", AUS + "banner.jpg");
    await sharp(AUS + "banner.jpg").resize(480, 252).jpeg({ quality: 78, mozjpeg: true }).toFile(AUS + "banner-thumb.jpg");
    fertig.push("banner");
    continue;
  }
  const tierKey = name.split("-")[0];
  const kopf = SONDER[name] ?? (TIERS[tierKey] && SAETZE[name] ? [...TIERS[tierKey], SAETZE[name]] : null);
  if (!kopf) { console.log("uebersprungen (kein Satz):", name); continue; }
  await karte(quelle, kopf, kopf[3], AUS + name + "-card.jpg");
  await gerahmt(quelle, 1080, 1080, kopf[2], AUS + name + "-square.jpg");
  // Kleines Vorschaubild fuer die Galerie im Bilder-Reiter.
  await sharp(AUS + name + "-square.jpg").resize(360, 360).jpeg({ quality: 78, mozjpeg: true }).toFile(AUS + name + "-thumb.jpg");
  fertig.push(name);
}
console.log(fertig.length + " Bilder gebaut: " + fertig.join(", "));
