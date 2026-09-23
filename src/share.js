// Teilen-Seiten: /s/<bild> liefert die Vorschau fuer X und Telegram (Titel,
// Satz, Bild) und schickt Menschen sofort auf die Startseite weiter.
//
// Warum eigene Adressen: X und Telegram haengen beim Teilen kein Bild an, sie
// holen es aus den og:-Tags der geteilten Adresse. Jeder Satz braucht also
// seine eigene Adresse, damit er sein eigenes Bild bekommt.
//
// Weitergeleitet wird per JavaScript, nicht per <meta refresh>: manche
// Vorschau-Crawler folgen einem Meta-Refresh und lesen dann die Tags der
// Startseite statt die des Satzes. JavaScript fuehren sie nicht aus.

const TIERS = {
  humpback: ["\u{1F40B}", "Humpback Whale"],
  whale: ["\u{1F433}", "Whale"],
  shark: ["\u{1F988}", "Shark"],
  dolphin: ["\u{1F42C}", "Dolphin"],
  fish: ["\u{1F41F}", "Fish"],
  octopus: ["\u{1F419}", "Octopus"],
  crab: ["\u{1F980}", "Crab"],
  shrimp: ["\u{1F990}", "Shrimp"],
  plankton: ["\u{1F9A0}", "Plankton"],
  microbe: ["\u{1F9EB}", "Microbe"],
  dust: ["\u{1F4A8}", "Dust"],
};

// Nur Saetze, deren Bilder in public/assets/share/ wirklich liegen
// (<id>-card.jpg fuer die Vorschau, <id>-square.jpg zum Posten).
export const SHARE_BILDER = {
  "humpback-proud": "only a handful of us live this deep. The ocean goes quiet when we move.",
  "humpback-funny": "I don't check the price. The price checks on me.",
  "humpback-calm": "deep water, long breath, zero rush.",
  "whale-proud": "when I surface, the whole chain feels the wave.",
  "whale-funny": "relax, I didn't sell. I just rolled over in my sleep.",
  "whale-calm": "eight figures deep and in no hurry.",
  "shark-proud": "calm on the surface, sharp underneath.",
  "shark-funny": "the whales think they're in charge. Cute.",
  "shark-calm": "patient. Circling. Never far from the action.",
  "dolphin-proud": "smart money swims in pods.",
  "dolphin-funny": "not the biggest in the ocean. Definitely having the most fun.",
  "dolphin-calm": "quick, clever, and keeping pace with the giants.",
  "fish-proud": "seven figures of ETN and still swimming upstream.",
  "fish-funny": "officially a millionaire. In ETN. Please don't do the conversion.",
  "fish-calm": "one million reasons to keep swimming.",
  "octopus-proud": "eight arms, zero paper hands.",
  "octopus-funny": "eight arms and not one of them can find the sell button.",
  "octopus-calm": "clever, flexible, and holding on with everything I've got.",
  "crab-proud": "hard shell, strong grip, not letting go.",
  "crab-funny": "sideways market? Crabs were literally built for this.",
  "crab-calm": "sideways is still forward.",
  "shrimp-proud": "six figures and punching above my weight.",
  "shrimp-funny": "the whales' favourite snack? Not today.",
  "shrimp-calm": "small on my own, but the ocean runs on us.",
  "plankton-proud": "no plankton, no whales. Simple biology.",
  "plankton-funny": "whales eat plankton? I'd like to see them try.",
  "plankton-calm": "the whole food chain is built on us.",
  "microbe-proud": "microscopic, but I'm on the chain.",
  "microbe-funny": "zoom in. No, more. More. There I am.",
  "microbe-calm": "everyone starts somewhere. This is my somewhere.",
  "dust-proud": "every whale started as a speck.",
  "dust-funny": "technically dust. Spiritually a whale.",
  "dust-calm": "dust today, a story tomorrow.",
};

// Bilder ohne Stufe: Wochenrueckblick und What-if-Vergleich. Beim Rueckblick
// entscheidet die Seite an der groessten Nachricht der Woche (wocheBild in
// public/app.js). Der Satz steht hier nur fuer die Bildbeschreibung.
export const SHARE_SONDER = {
  "week-bridge": "Busy week at the migration bridge.",
  "week-whale": "A whale made waves this week.",
  "week-busy": "Electroneum got busier this week.",
  "week-radar": "The week in numbers.",
  "whatif-scale": "Not a forecast. Just math.",
  "whatif-dream": "What if ETN were that big?",
  "whatif-napkin": "Napkin math for ETN.",
  "price-hype": "Electroneum is on the move.",
  "price-next": "Where does ETN go from here?",
  "price-napkin": "Napkin math on ETN.",
};
// Emoji, Name, Titel und Ziel je Art der Sonderbilder.
const SONDER_ART = {
  week: ["\u{1F5D3}", "This week", "This week on Electroneum - the full recap on ETN Radar", "/"],
  whatif: ["\u{1F9EE}", "What if", "What would one ETN cost? Do the math on ETN Radar", "/whatif"],
  price: ["\u{1F4B0}", "ETN price", "The ETN price, live on ETN Radar", "/"],
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function shareSeite(u, id) {
  // ?w=0x... : jemand zeigt ein fremdes Wallet - Menschen landen dann direkt dort.
  const w = u.searchParams.get("w") ?? "";
  const wallet = /^0x[0-9a-fA-F]{40}$/.test(w) ? w : null;
  const sonder = SHARE_SONDER[id] ? SONDER_ART[id.split("-")[0]] : null;
  const ziel = sonder ? sonder[3] : wallet ? "/wallet/" + wallet : "/";
  const satz = SHARE_SONDER[id] ?? SHARE_BILDER[id];
  const tier = sonder ?? TIERS[id.split("-")[0]];
  if (!satz || !tier) return Response.redirect(new URL(ziel, u).href, 302);

  // Jedes Teil sagt etwas anderes, sonst steht derselbe Satz dreimal da:
  // der Post nennt die Stufe, das Bild bringt den Satz, der Titel (bei X ueber
  // dem Bild eingeblendet) laedt zum Mitmachen bzw. Nachschauen ein.
  const [emoji, name] = tier;
  const titel = sonder
    ? sonder[2]
    : wallet ? "Look this wallet up on ETN Radar" : "What's your tier? Find out on ETN Radar";
  const beschreibung = "Whale and migration tracker for the Electroneum Smart Chain.";
  // Immer das breite Bild: eine Vorschaukarte ist breit, ein Quadrat wuerde abgeschnitten.
  const bild = u.origin + "/assets/share/" + id + "-card.jpg";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(emoji + " " + name + " · ETN Radar")}</title>
<meta name="description" content="${esc(beschreibung)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ETN Radar">
<meta property="og:url" content="${esc(u.origin + "/s/" + id + (wallet ? "?w=" + wallet : ""))}">
<meta property="og:title" content="${esc(titel)}">
<meta property="og:description" content="${esc(beschreibung)}">
<meta property="og:image" content="${esc(bild)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(name + ": " + satz)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(titel)}">
<meta name="twitter:description" content="${esc(beschreibung)}">
<meta name="twitter:image" content="${esc(bild)}">
<script>location.replace("${ziel}");</script>
</head>
<body><a href="${ziel}">ETN Radar</a></body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
