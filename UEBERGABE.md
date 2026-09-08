# ETN Radar — Übergabe

Stand: **08.09.2026**. Live unter <https://etn-radar.galacticsl.com>.

Dieses Dokument beantwortet die Fragen, die in einem frischen Chat sonst neu
gestellt werden müssten: **Was aktualisiert sich wann?** **Was hält die Seite
aus?** **Was ist noch offen?**

Die Begründungen zu einzelnen Entscheidungen stehen als Kommentare im Code, an
der Stelle, an der sie gelten. Die [README](README.md) erklärt die Fachlogik.

---

## 1. Das Wichtigste in einem Satz

Die Seite **rechnet nie, wenn jemand sie aufruft**. Alles Aufwendige passiert
vorher in GitHub Actions und landet in einer Datenbank; der Besucher bekommt
nur fertige Zeilen zu lesen. Deshalb kostet der tausendste Besucher genauso
wenig wie der erste.

---

## 2. Was aktualisiert sich wann?

| Bereich | Wie oft | Wer macht es | Was passiert |
|---|---|---|---|
| **Balancen, Ränge, Ereignisse** | alle **30 Minuten** | `snapshot.yml` | Top 3.000 Wallets vom Explorer holen, Änderungen schreiben, Ereignisse ableiten |
| **Migration Watch, Bridge-Stand** | alle 30 Minuten | derselbe Lauf | Bridge-Bestand, Tagesbilanz, Hochrechnung auf die Deadline |
| **Kurs (24H-Kurve)** | alle 30 Minuten | derselbe Lauf | ein Kurspunkt je Snapshot |
| **Netzwerkzahlen** (Blockhöhe, Gas, Auslastung) | **live** | Worker | direkt vom Explorer, 10 Minuten zwischengespeichert |
| **Kurs (7D bis 1Y)** | täglich | eigene Snapshots | Tagesreihe aus dem jeweils frühesten Snapshot des Tages |
| **Tiefenzählung** (Crab…Microbe) | **sonntags** 03:30 UTC | `census.yml` | bis zu 90.000 Adressen zählen, nur Summen je Stufe |
| **Große Migrations-Ereignisse** | **montags** 03:30 UTC | `bridge-events.yml` | Bridge-Historie weiter durchblättern, Ereignistage neu aufbauen |
| **Cluster-Vermutungen** | **mittwochs** 03:30 UTC | `clusters.yml` | gemeinsame Finanzierungsquellen der Top 1.000 |
| **Börsen-Erkennung** | **freitags** 03:30 UTC | `exchange-detect.yml` | Verhaltensmuster bewerten, Verdachtsfälle markieren |
| **Schema-Migrationen** | täglich 04:xx UTC + vor jedem Wochenjob | alle Workflows | `migrations.sql` anwenden, best effort |

Die vier Wochenjobs sind zusätzlich **von Hand auslösbar** — im Dashboard über
die „Run now"-Knöpfe (nur für dich sichtbar, siehe Abschnitt 5) oder im
Actions-Tab. Sperre danach: 24 Stunden, beim Bridge-Job **3 Stunden**, weil er
sich über mehrere Läufe durch die Historie arbeitet.

**Der Besucher löst nichts davon aus.** Ein Seitenaufruf liest ausschließlich.

---

## 3. Hält das Andrang aus?

Ja. Die Zahlen, gemessen am 08.09.2026:

| Grenze (Gratis-Tarif) | Verbrauch | Anteil |
|---|---|---|
| D1: 100.000 **geschriebene** Zeilen/Tag | ~1.344 (48 Snapshots × 28) | **1,3 %** |
| D1: 5.000.000 **gelesene** Zeilen/Tag | 50 je Ranglisten-Seite | unkritisch |
| Workers: 100.000 Anfragen/Tag | ~6 API-Aufrufe je Besuch | ~16.000 Besuche/Tag |
| GitHub Actions | unbegrenzt (öffentliches Repo) | — |

Zwei Dinge tragen das:

**Der Zwischenspeicher.** Jede API-Antwort trägt `max-age=600`. Zehn Minuten,
obwohl die Daten sich nur alle 30 Minuten ändern. Antworten aus dem Cache
berühren die Datenbank überhaupt nicht.

**Der schnelle Weg in der Rangliste.** Ohne Filter ist der Rang die Position in
der nach Bestand sortierten Liste — dafür gibt es einen Index, das kostet
**50 gelesene Zeilen**. Die gefilterte Fassung rechnet die ganze Liste durch
(15.014 Zeilen) und wird nur benutzt, wenn jemand bewusst filtert. Ohne diese
Trennung wäre bei rund 330 Aufrufen am Tag Schluss gewesen.

Der Preis: die Spalte **„RANK Δ" bleibt in der ungefilterten Ansicht leer** —
sie bräuchte den Bestand aller Wallets von damals. Zurückholen ließe sie sich
mit einem täglichen Rang-Schnappschuss (~3.000 Schreibzeilen, 3 % des
Budgets).

---

## 4. Woher kommen die Daten?

Alles Kettenbezogene aus **einer** Quelle: `blockexplorer.electroneum.com`.
Keine Daten von PlanetETN — das ist eine ausdrückliche Projektregel.

Die **Kurshistorie vor dem 07.09.2026** wurde einmalig von CoinGecko geholt
(`scripts/price-backfill.mjs` → Tabelle `price_history`) und wächst seither aus
den eigenen Snapshots. Im laufenden Betrieb braucht die Seite **keine fremde
Kursquelle**. Drei Versuche, den Kurs live von außen zu holen, scheiterten an
IP-Sperren — CoinGecko antwortet Workern ohne User-Agent mit 403 und mit
Kennung dann 429, Coinpaprika mit 402. Die Einzelheiten stehen im Kopf von
`preisverlauf()` in `src/index.js`.

---

## 5. Betrieb

**Admin-Zugang.** Einmal `https://etn-radar.galacticsl.com/?admin=<DEIN WORT>`
aufrufen; der Browser merkt es sich. Danach erscheinen die „Run now"-Knöpfe und
der Feedback-Posteingang. Für alle anderen sind sie unsichtbar. Das Wort ist
das Cloudflare-Secret `ADMIN_TOKEN` — **nicht** der GitHub-Token.

**Secrets** (in Cloudflare, per `npx wrangler secret put`):
`ADMIN_TOKEN`, `GITHUB_PAT`. In GitHub Actions: `CLOUDFLARE_ACCOUNT_ID`,
`D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`.

**Der Bridge-Knopf** sitzt im Reiter *Migration*, unten in „Big migration
events". Er arbeitet die Bridge-Historie (seit 03.03.2024) in Häppchen von 400
Seiten ab und merkt sich, wie weit er kam. Ein Abbruch kostet höchstens das
laufende Häppchen.

**Ein neues Wallet-Label eintragen:** in `labels.json` ergänzen, dann entweder
`node scripts/apply-labels.mjs --remote` (braucht die Cloudflare-Umgebung) oder
direkt per `npx wrangler d1 execute etn-tracker --remote -y --command "…"`.

---

## 6. Was offen ist

- **Telegram-Weckalarm.** Der komplette Code liegt seit Wochen bereit
  (`src/telegram.js`): Webhook, `/watch`, `/unwatch`, Benachrichtigung bei
  erwachten Sleepern. Es fehlt nur ein Bot bei @BotFather, zwei Secrets und der
  Eintrag `TELEGRAM_BOT_USERNAME` in `wrangler.toml`. Solange der fehlt, ist das
  Feature unsichtbar — nichts bricht.
- **Bridge-Historie.** Der Durchgang über 917 Tage ist noch nicht durch.
  Mehrmals auf „Scan for events now" drücken, bis im ⓘ „Covers the whole
  history" steht.
- **Börsen-Labels.** Neun Adressen sind automatisch als Verdachtsfall markiert
  (Score ≥ 0,7) und warten auf Bestätigung. Das ist die Stelle, an der
  Handarbeit am meisten bringt.
- **„RANK Δ"** in der ungefilterten Rangliste, siehe Abschnitt 3.
- **Kurslücken.** Fällt ein ganzer Tag ohne Snapshot aus, fehlt er in der
  Jahreskurve. `node scripts/price-backfill.mjs` einmal im Jahr stopft das.

---

## 7. Projektregeln

- **Keine laufenden Kosten.** Gratis-Tarife sind harte Anforderung, kein
  bezahlter Plan.
- **Datenquelle ist der Block-Explorer**, nicht PlanetETN.
- **Keine Erklärtexte in der Oberfläche.** Meta-Fußnoten unter Diagrammen
  weglassen; wenn etwas erklärt werden muss, gehört es ins ⓘ-Popup.
- **Keine Auflistung von Code-Änderungen** im Gespräch — Ergebnis und
  Konsequenz genügen.
