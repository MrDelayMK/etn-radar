# ETN Radar - Arbeitsanweisung und Wiedereinstieg

Stand: **12.10.2026**. Live: <https://etn-radar.galacticsl.com> · Repo: `MrDelayMK/etn-radar`

MrDelayMK pausiert ab Oktober 2026 das Claude-Pro-Abo. Diese Datei ist beides:
die Regeln für die Arbeit am Projekt **und** die Liste dessen, was in der Pause
von allein weiterläuft. Wer hier neu einsteigt, liest zuerst Abschnitt 1 und 2.

Ergänzend: [README.md](README.md) erklärt die Fachlogik, [UEBERGABE.md](UEBERGABE.md)
den Stand vom September. Begründungen zu Einzelentscheidungen stehen als
Kommentare im Code an der Stelle, an der sie gelten.

---

## 1. Erst prüfen, dann arbeiten

Nach einer längeren Pause in dieser Reihenfolge:

```bash
curl -s "https://etn-radar.galacticsl.com/api/overview?limit=1"
```
Darin `snapshot.taken_at`: **älter als 40 Minuten ist nicht normal.**

```bash
curl -s "https://api.github.com/repos/MrDelayMK/etn-radar/actions/runs?per_page=50"
```
Läufe je Tag zählen. Soll: ~48 Snapshots (meist als `workflow_dispatch` vom
Wächter), 1 Bridge-Scan, sonntags 1 Census. Gescheiterte Läufe sind meist
Explorer-Störungen und heilen von allein.

Frische aller Datenquellen (eine Abfrage, ~900 gelesene Zeilen):

```bash
npx --yes wrangler@4.131.0 d1 execute etn-tracker --remote --yes --command "SELECT 'bridge_tage' q, max(day) stand FROM bridge_tage UNION ALL SELECT 'network_daily', max(day) FROM network_daily UNION ALL SELECT 'token_kerzen', max(tag) FROM token_kerzen"
```

Soll: `bridge_tage` und `network_daily` = heute, `token_kerzen` = gestern oder heute.

Dann `npm test` (13 Dateien, ~3 Minuten). Die Tests mit `lokal-` im Namen nutzen
`data/etn.db`; diese Kopie endet am 07.09.2026 und altert weiter - einzelne
Prüfungen überspringen sich deshalb selbst. Das ist gewollt, nicht kaputt.

## 2. Was in der Pause von allein läuft

| Was | Wann | Woher |
|---|---|---|
| Snapshot (Top 3.000, ETN-Kurs, Ereignisse) | alle 30 Min | GitHub Action + Wächter im Worker |
| Bridge-Scan (Migrationen) | täglich 01:30 UTC | GitHub Action |
| Census (Leaderboard bis 25K ETN) | sonntags 03:30 UTC | GitHub Action |
| Cluster-Analyse | mittwochs 03:30 UTC | GitHub Action |
| Börsen-Erkennung | freitags 03:30 UTC | GitHub Action |
| Tokenpreise, NFT-Bodenpreise, Kerzen | täglich bzw. wöchentlich, beim Besuch | ElectroSwap-API aus dem Worker |
| Marktkapitalisierungen (What if) | täglich im Snapshot-Lauf | CoinGecko |

**Der Wächter ist das Herzstück dieser Pause.** GitHub startet seinen eigenen
Zeitplan kaum noch (3 bis 4 von 48 Läufen). Cloudflare ruft den Worker deshalb
alle 10 Minuten auf; ist der letzte Snapshot älter als 28 Minuten, stößt der
Worker den GitHub-Lauf selbst an (`src/waechter.js`, `wrangler.toml` → `[triggers]`).
Ohne ihn stünde die Seite nach wenigen Stunden still.

Laufende Kosten: **keine.** Cloudflare Workers/D1 im Gratis-Tarif, GitHub Actions
unbegrenzt (öffentliches Repo), ElectroSwap aus dem Arc-Kontingent (102 DYNO,
48.000 Gratis-Credits/Tag, Verbrauch rund 2.000). Das hält ohne Zutun.

**Termine, die nicht vergessen werden dürfen**

- **31.01.2027 - Migrations-Stichtag.** Danach schaltet die Migrationsseite
  automatisch auf Bilanz um ("Before and after", verlorene ETN statt Countdown).
  Der Code dafür liegt in `src/api/migration.js` und `public/app.js`, ist aber im
  Echtbetrieb nie gelaufen. **Vor dem Stichtag einmal durchsehen.**
- Der Bridge-Scan läuft bis zum Stichtag täglich weiter; danach genügt wöchentlich.
- Die Spendenadresse in `wrangler.toml` (`DONATE_ADDRESS`) ist noch vorläufig.

**Was in der Pause kaputtgehen kann, ohne dass es jemand merkt**

- ElectroSwap-Schlüssel abgelaufen oder DYNO verkauft → Tokenpreise, NFT-Werte
  und die Chain-Seite bleiben leer. Die restliche Seite läuft weiter.
- D1-Gratis-Tarif: 100.000 geschriebene Zeilen am Tag. Der Snapshot schreibt nur
  noch geänderte Adressen (etwa 9 von 3.000), der Sonntags-Census rund 43.000.
  Wer die Snapshot-Frequenz erhöht oder wieder alle Adressen schreibt, reißt das
  Limit - dann brechen die Jobs ab.
- Explorer-Störungen: einzelne Läufe scheitern, der Wächter holt nach.

## 3. Feste Regeln (von MrDelayMK gesetzt)

- **Gratis-Tarif ist Pflicht.** Keine Funktion, die laufende Kosten erzeugt.
- **Keine Spam-Anfragen an den ETN-Blockexplorer.** Live höchstens 4 Anfragen pro
  Minute, Hintergrundläufe maximal 1,5/s adaptiv. Vor jedem Umbau die zu
  erwartende Anfragezahl nennen.
- **Keine Verbindung zu ETN Pulse**, nichts von dort kopieren.
- **ElectroSwap:** nur die öffentliche API (`/public-api/v1`). `/graphql` und
  `/api/` sind verboten - das gibt einen Firewall-Bann für alle Dienste.
- **Zugangsdaten fasst Claude nie an.** `ADMIN_TOKEN`, `GITHUB_PAT`,
  `CLOUDFLARE_API_TOKEN`, `ELECTROSWAP_API_KEY` setzt der Betreiber selbst.
  Nicht danach fragen, nicht vorschlagen, sie zu schicken.
- **`npm test` vor jedem Ausrollen**, und zwar so, dass ein roter Test auffällt
  (nicht in eine Pipe hängen, die den Exit-Code schluckt).
- **Deploys sammeln:** nicht einzeln ausrollen, Gesamtstand vorlegen und
  freigeben lassen.
- **D1-Lesekosten messen** (`rows_read`), bevor eine neue Abfrage live geht.
- **Texte auf der Seite und in Share-Posts:** Englisch, und **nie** den langen
  Gedankenstrich "—", immer "-". Keine Erklär-Fußnoten unter Diagrammen; wenn
  etwas erklärt werden muss, als ⓘ-Knopf.
- **In Antworten an MrDelayMK:** kein Auflisten von Code-Änderungen, sondern
  Ergebnis und Konsequenz. Er prüft visuell, nicht im Code.
- **Neue Share-Bilder** müssen am Ende im Bilder-Reiter stehen, in **beiden**
  Fassungen (nur Bild und Bild + Text). Schrittfolge in Abschnitt 5.

## 4. Befehle

```bash
npm test                      # alle 13 Testdateien (~3 Min)
npm run test:schnell          # die schnellen 7
npx --yes wrangler@4.131.0 deploy
node scripts/share-bilder.mjs hold-proud   # nur dieses Bild neu bauen
```

Datenbank (immer `--command`, **nie** `--file`, das scheitert mit Auth-Fehler 10000):

```bash
npx --yes wrangler@4.131.0 d1 execute etn-tracker --remote --yes --command "SELECT ..."
```

Vorschau lokal: `node scripts/serve-local.mjs 8788 ./data/etn.db`

**Zwischenspeicher:** Antworten der API liegen im Cache des Workers. Ein Deploy
leert ihn **nicht**. Zum Testen einen Parameter aus der Whitelist anhängen
(`?limit=7`), sonst sieht man die alte Antwort.

**Shell:** Heredocs und `node -e` verschlucken Backslashes. Patch-Skripte mit dem
Write-Werkzeug anlegen, `replace` mit Funktion als Ersatz, und Dateien mit CRLF
vor dem Suchen normalisieren.

## 5. Neues Share-Bild einbauen

1. Rohbild nach `Bilder/share-roh/<id>.jpg` (Prompt-Regeln: siehe Memory-Notiz
   "share-bilder", Stil je Stimmung ist festgelegt).
2. Kopfzeile, Farbe und Satz in `SONDER` in `scripts/share-bilder.mjs`.
3. `node scripts/share-bilder.mjs <id>` - baut Karte, Rahmen und beide Vorschauen.
4. Satz in `SHARE_SONDER`, Prefix in `SONDER_ART` (`src/share.js`).
5. `GAL_SONDER`, `GAL_ART`, `GAL_GRUPPEN` in `public/app.js`.
6. Bei neuem Prefix die Regex in `tests/share.test.mjs` erweitern.
7. `npm test`, ausrollen, live nachsehen.

## 6. Aufbau in Kürze

- **Worker** (`src/`) liest nur und liefert Seite und JSON-API. Das Einsammeln
  macht GitHub Actions (`scripts/*-remote.mjs`), weil der Gratis-Worker nur
  10 ms CPU je Aufruf hat.
- **D1** (`etn-tracker`) ist die einzige Datenhaltung. Schema in `schema.sql`,
  Änderungen zusätzlich in `migrations.sql` (wird bei jedem Lauf idempotent
  wiederholt).
- **Frontend**: eine Datei `public/app.js`, kein Build-Schritt, kein Framework.
- **Teilen**: `/s/<bild>` liefert og-Tags mit der breiten Karte; `?w=0x…` lenkt
  den Klick auf ein Wallet.

## 7. Was offen geblieben ist

- Share-Schritt 4: Ereignis-Zusätze im Teilen-Text ("aufgewacht nach X Jahren",
  "nicht migriert").
- Spendenadresse endgültig festlegen.
- Verhalten nach dem 31.01.2027 einmal im Echtbetrieb prüfen (siehe Abschnitt 2).

Alles andere aus der To-do-Liste ist gebaut und live. MrDelayMK am 29.09.2026:
"die webseite ist fertig, für den moment."
