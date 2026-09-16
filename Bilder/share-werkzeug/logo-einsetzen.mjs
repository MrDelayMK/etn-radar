import { readFileSync, writeFileSync } from "node:fs";
const dir = "C:/Users/der_m/AppData/Local/Temp/claude/C--Users-der-m-OneDrive-00-PROGRAMMIEREN-KI-Blockchain-Wallet-Compare/cc6c8491-faec-4182-87fb-d198c40d7e7b/scratchpad/";
const logo = readFileSync("C:/Users/der_m/OneDrive/00_PROGRAMMIEREN_KI/Blockchain_Wallet_Compare/public/assets/favicon.png").toString("base64");
let html = readFileSync(dir + "share-kit.src.html", "utf8").replaceAll("__LOGO__", () => "data:image/png;base64," + logo);

// Seitenskript einmal mit einem Minimal-DOM ausfuehren: prueft, dass es ohne
// Fehler durchlaeuft, und liefert die Karten als festes HTML - so stehen die
// Prompts auch in Ansichten da, in denen kein JavaScript laeuft.
const skript = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
const els = {};
const mk = () => ({ innerHTML: "", textContent: "", style: {}, dataset: {}, addEventListener() {}, setAttribute() {},
  classList: { toggle() {}, add() {}, remove() {} } });
const document = { getElementById: (id) => (els[id] ??= mk()), querySelector: (s) => (els[s] ??= mk()),
  querySelectorAll: () => [], createElement: mk, body: mk() };
const localStorage = { getItem: () => null, setItem() {} };
new Function("document", "localStorage", "navigator", skript)(document, localStorage, {});

if (!els.gruppen.innerHTML.includes("Prompt kopieren")) throw new Error("keine Karten erzeugt");
html = html
  .replace('<div id="gruppen"></div>', () => '<div id="gruppen">' + els.gruppen.innerHTML + "</div>")
  .replace('<div class="sprung" id="sprung"></div>', () => '<div class="sprung" id="sprung">' + els.sprung.innerHTML + "</div>")
  .replace('<span id="zaehler">0 / 41</span>', () => '<span id="zaehler">' + els.zaehler.textContent + "</span>");
writeFileSync(dir + "share-kit.html", html);
console.log("ok", html.length, "Karten:", (els.gruppen.innerHTML.match(/class="bild/g) || []).length);
