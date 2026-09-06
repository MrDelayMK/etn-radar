# ETN Radar

Top-Holder- und Migrations-Tracker für die **Electroneum Smart Chain**.

Beantwortet die Frage, die sich mit der Legacy-Deadline (31.01.2027) stellt:
*Wie verhalten sich die großen Wallets, je näher der Stichtag rückt?*

Getrackt wird **Bestand**: Balancen, Ränge, Tiers, Konzentration und der
Migrationsfortschritt der Bridge.

---

## Was es zeigt

| Bereich | Inhalt |
|---|---|
| **Migration Watch** | Bridge-Bestand = noch nicht migrierte Legacy-Supply, Abflussrate, Hochrechnung auf die Deadline |
| **Sleeper Watch** | Wallets, die seit Monaten oder Jahren unbewegt sind — und Alarm, wenn eines aufwacht |
| **Tier-System** | 11 Stufen, Dust → Humpback Whale, mit Abstand zur nächsten Stufe |
| **Top Movers** | größte Zu- und Abflüsse über den gewählten Zeitraum |
| **Leaderboard** | Rang, Balance, Δ, Ruhedauer, Börsen-/Contract-Markierung |
| **Ereignisse** | Tier-Wechsel, geleerte Wallets, Neuzugänge, erwachte Schläfer |

Zeiträume überall: **24H · 7D · 30D · 90D · 6M**.
Oberfläche auf Englisch (3 Reiter: Overview, Leaderboard, Activity),
Code-Kommentare auf Deutsch.

## Architektur

```
GitHub Action (alle 30 Min)       Cloudflare (kostenlos)
  scripts/ingest-remote.mjs  ──►  D1-Datenbank  ◄──  Worker (nur lesend)
  Blockscout-API                                       └─ public/index.html
```

Der Ingest läuft **außerhalb** von Cloudflare, weil Workers Free nur 10 ms CPU
pro Cron-Ausführung erlaubt — für tausende Adressen zu wenig. Lesende Abfragen
bleiben weit darunter. Alles im kostenlosen Kontingent.

---

## Einrichtung

### 1. Cloudflare-Datenbank anlegen

```bash
npx wrangler login
```

```bash
npx wrangler d1 create etn-tracker
```

Die ausgegebene `database_id` in [`wrangler.toml`](wrangler.toml) eintragen
(ersetzt `PLATZHALTER_NACH_DB_CREATE_EINSETZEN`). Dann das Schema anlegen:

```bash
npx wrangler d1 execute etn-tracker --remote --file=./schema.sql
```

Das legt alle Tabellen an. `schema.sql` enthält bewusst **nur** CREATE-
Anweisungen — spätere Spalten-Ergänzungen stehen in
[`migrations.sql`](migrations.sql) und werden separat angewendet:

```bash
npm run db:migrate
```

Bei einer frischen Datenbank meldet das nur „schon vorhanden" und ist damit
gefahrlos. Nötig ist es, wenn die Datenbank älter ist als eine neue Spalte.

### 2. Worker veröffentlichen

```bash
npx wrangler deploy
```

### 3. GitHub-Repository und Secrets

Repository anlegen, Code pushen, dann unter
**Settings → Secrets and variables → Actions** drei Secrets setzen.

> **Öffentlich oder privat?** Der Snapshot läuft alle 30 Minuten, also 48
> Läufe pro Tag. GitHub rechnet pro Lauf auf volle Minuten auf — das sind
> mindestens ~1.440 Minuten im Monat, realistisch eher 2.500–2.900. Für
> **private** Repos sind nur 2.000 Minuten im Monat gratis, das reißt.
> Für **öffentliche** Repos sind Actions-Minuten unbegrenzt gratis. Wer das
> Repo privat halten will, sollte den Cron in
> [`snapshot.yml`](.github/workflows/snapshot.yml) auf stündlich stellen
> (`0 * * * *`).

| Secret | Woher |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare-Dashboard, rechte Spalte |
| `D1_DATABASE_ID` | Ausgabe von `wrangler d1 create` |
| `CLOUDFLARE_API_TOKEN` | Profil → API Tokens → Create Token → Berechtigung **D1: Edit** |

### 4. Erstbefüllung

In **Actions** nacheinander von Hand starten:

1. **ETN Snapshot** — erster Bestand (danach automatisch alle 30 Min)
2. **ETN Backfill** — holt die Historie und die echten Bewegungsdaten
3. **ETN Tier Census** — zählt Crab bis Microbe (danach automatisch wöchentlich, sonntags)
4. **ETN Cluster Analysis** — optional, Cluster-Vermutungen (siehe unten; automatisch mittwochs)
5. **ETN Exchange Detection** — optional, markiert Börsen-/Dienst-Kandidaten (automatisch freitags)
6. **ETN Bridge Events** — optional, große Migrations-Tage samt Empfängern (siehe unten; automatisch montags)

Backfill, Census und Cluster Analysis sind wiederaufsetzbar bzw. laufen bei
Bedarf einfach erneut; siehe [„Zwei Geschwindigkeiten"](#zwei-geschwindigkeiten-snapshot-vs-tiefenzählung)
weiter unten für die Begründung des Takts.

### 5. Bekannte Adressen setzen

```bash
node scripts/apply-labels.mjs --remote
```

Liest [`labels.json`](labels.json) und schreibt Börsen-, Bridge- und
Team-Markierungen. Nach jeder Ergänzung erneut ausführen — idempotent, es
werden nur die Label-Felder überschrieben, nie Messdaten.

Bereits eingetragen: ETN Bridge, HTX, KuCoin, Biconomy. Als `exchange` oder
`bridge` markierte Adressen verschwinden im Dashboard hinter dem Schalter
**„Real wallets only"**.

### 6. Bevor es öffentlich erreichbar wird

Solange die Seite privat lief, war das egal — öffentlich nicht mehr:

**Die „Run now"-Knöpfe absichern.** Sie starten GitHub-Actions-Läufe, also
Arbeit auf deine Kosten, und belegen die 24-Stunden-Sperre. Ohne Schutz kann
das jeder mit der URL. Ein langes Zufallswort als Secret setzen:

```bash
npx wrangler secret put ADMIN_TOKEN
```

Danach die Seite **einmal** mit `?admin=<dasselbe Wort>` aufrufen. Der
Browser merkt es sich lokal, die URL wird sofort wieder sauber, und die
Knöpfe erscheinen nur noch bei dir — für alle anderen sind sie unsichtbar
(und ein direkter Aufruf des Endpoints antwortet mit 403). Ohne gesetztes
`ADMIN_TOKEN` bleibt alles offen wie bisher.

**Was bewusst offen bleibt:** `/api/search` schlägt unbekannte Adressen live
beim Explorer nach. Antworten werden zwei Minuten gecacht und es werden nur
gültige Adressen weitergereicht, aber bei sehr viel Fremdverkehr wäre das die
Stelle, an der zuerst der Explorer bremst. Erst beobachten, dann bei Bedarf
nachschärfen — vorher lohnt der Aufwand nicht.

**Keine Geheimnisse im Repo:** Tokens liegen ausschließlich in
Cloudflare-Secrets und GitHub-Secrets, nie in einer Datei. `data/` (die
lokale SQLite) und `.dev.vars` sind über `.gitignore` ausgeschlossen.

---

## Lokal entwickeln

Ohne Cloudflare, gegen eine SQLite-Datei:

```bash
node scripts/ingest-local.mjs 500 ./data/etn.db
```

```bash
node scripts/backfill.mjs ./data/etn.db 6
```

Tiefenzählung (Crab bis Microbe; optional, dauert je nach `tiefe` mehrere
Minuten bis über eine Stunde — läuft mit derselben ~3-Anfragen/s-Bremse wie
alles andere):

```bash
node scripts/census-local.mjs 90000 ./data/etn.db
```

Cluster-Analyse (optional; `limit` begrenzt zum Testen, sonst werden alle
Fast-Tier-Wallets geprüft — bei ~2.000-3.000 dauert das 15-25 Minuten):

```bash
node scripts/clusters-local.mjs 50 ./data/etn.db
```

Exchange-Erkennung (optional; prüft ungelabelte Top-Wallets, überschreibt nie
ein bestehendes Label):

```bash
node scripts/exchange-detect-local.mjs 50 ./data/etn.db
```

```bash
node scripts/serve-local.mjs 8787 ./data/etn.db
```

Dann http://localhost:8787 öffnen. `scripts/serve-local.mjs` führt denselben
Worker-Code aus wie Cloudflare, nur gegen die lokale Datenbank.

---

## Rücksicht auf den Explorer

`blockexplorer.electroneum.com` ist eine öffentliche, unbezahlte Ressource und
antwortet mit **HTTP 429**, wenn man sie überfährt — beim Bauen einmal passiert.

Alle Anfragen laufen deshalb durch eine **gemeinsame Bremse** in
[`src/blockscout.js`](src/blockscout.js): rund 3 Anfragen pro Sekunde,
unabhängig davon, wie viele Worker parallel arbeiten. Ein 429 pausiert
sämtliche Anfragen (respektiert `Retry-After`), nicht nur die betroffene.
Parallelität erhöht dadurch nur die Auslastung der Wartezeit, nie die Rate.

Wer die Rate ändert, tut das an genau einer Stelle: `setRate(anfragenProSekunde)`.

## Drei Fallstricke der Explorer-API

Alle beim Bauen gefunden, alle behoben — wer den Code anfasst, sollte sie kennen:

**1. `coin-balance-history-by-day` ist leer statt flach.**
Hat ein Wallet sich im 90-Tage-Fenster nicht bewegt, liefert der Endpoint eine
*leere Liste*, keine gleichbleibende Linie. Wer daraus „keine Historie" schließt,
datiert ausgerechnet die längsten Schläfer als „heute bewegt" — die
Sleeper-Erkennung wäre exakt invertiert. Lösung: Fallback auf
`coin-balance-history`, der zeitlich unbegrenzt zurückreicht
(siehe [`src/backfill.js`](src/backfill.js)).

**2. `transaction_count` ist unzuverlässig.**
Kommt in der Listen-Abfrage gelegentlich als leerer String und fehlt im
Einzeladress-Endpoint komplett. Deshalb wird beim Upsert mit `COALESCE`
gearbeitet, und „Schläfer" ist über die **Ruhedauer** definiert, nicht über
die Transaktionszahl.

**3. `coin-balance-history` liefert nur die 50 neuesten Änderungen pro Seite.**
Bei Börsen-Wallets mit zehntausenden Transaktionen decken die keine zwei Wochen
ab. Der Backfill blättert deshalb bis zu 8 Seiten tief; wo das nicht reicht,
rechnet die API ab dem ältesten bekannten Punkt und liefert dessen Datum mit
(`delta_ab`), statt „unbekannt" anzuzeigen.

Außerdem: ETN-Beträge sind Wei-Werte mit bis zu 28 Stellen und passen **nicht**
in einen SQLite-`INTEGER`. Sie werden exakt als `TEXT` gespeichert, mit einer
zusätzlichen `REAL`-Spalte nur zum Sortieren. Differenzen immer über `BigInt`.

---

## Zwei Geschwindigkeiten: Snapshot vs. Tiefenzählung

Wallets im Wert von ein paar Cent müssen nicht alle 30 Minuten verfolgt werden.
Die Tier-Skala ist deshalb in zwei Gruppen geteilt (siehe [`src/tiers.js`](src/tiers.js)):

| Stufen | Quelle | Takt | Speicherung |
|---|---|---|---|
| Humpback … Octopus (≥ 500.000 ETN) | normaler Snapshot | alle 30 Min | einzeln, mit Verlauf, im Leaderboard durchblätterbar |
| Crab, Shrimp, Plankton, Microbe (5.000 – 500.000 ETN) | [`src/census.js`](src/census.js) | wöchentlich (sonntags) + jederzeit per Knopf | nur Summen, keine einzelnen Zeilen |
| Dust (< 5.000 ETN) | — | — | reine Restrechnung: `total_addresses − alles nachweislich Darüberliegende` |

Der Schnitt bei Octopus ist eine Entscheidung darüber, wo Whale-Watching mit
6-Stunden-Auflösung noch sinnvoll ist — nicht eine Kostenfrage, beide Tiefen
sind für sich genommen günstig. `TRACK_TOP_N` (Snapshot) und `CENSUS_DEPTH`
(Tiefenzählung, real gemessen: 5.000 ETN liegt bei Rang ~61.800, `CENSUS_DEPTH`
gibt 45 % Sicherheitsspanne darüber) sind in [`wrangler.toml`](wrangler.toml)
getrennt einstellbar.

**„Run now"-Knöpfe im Dashboard** (Census und Cluster-Analyse, siehe unten):
Der Worker kann diese 15-30-minütigen Läufe nicht selbst ausführen (10 ms
CPU-Limit), die Knöpfe lösen stattdessen den jeweiligen GitHub-Actions-Workflow
per API aus — mit einer serverseitigen 24h-Sperre pro Job, damit Klicks den
Explorer nicht wiederholt belasten. Dafür einmalig einrichten:

```bash
npx wrangler secret put GITHUB_PAT
```

Fine-grained Personal Access Token mit **„Actions: Read and write"** nur auf
dieses eine Repository (GitHub → Settings → Developer settings → Fine-grained
tokens) — gilt für beide Workflows. `GITHUB_OWNER`/`GITHUB_REPO` in
[`wrangler.toml`](wrangler.toml) eintragen. Ohne gesetztes Secret zeigen die
Knöpfe einen Hinweis auf den manuellen Weg über den Actions-Tab — nichts
bricht dadurch.

**Nebeneffekt:** Das Leaderboard mit Verlauf und Delta ist nur bis zur
Snapshot-Tiefe durchblätterbar. Einzelne Crab/Shrimp/Plankton/Microbe/Dust-Wallets
bleiben trotzdem über `/api/search` nachschlagbar — das fragt für unbekannte
Adressen live beim Explorer nach, unabhängig von der Snapshot-Tiefe.

Vor dem ersten Census-Lauf zeigen die unteren Stufen ehrlich „not yet counted"
statt einer erfundenen Zahl.

---

## Cluster-Vermutungen (experimentell)

Eigener Tab, unabhängig vom Leaderboard: welche Wallets teilen sich eine
erkennbare **Finanzierungsquelle**? Das kann dieselbe Person oder Gruppe sein,
muss es aber nicht — z. B. zahlt ein Team-Treasury-Wallet oft mehrere echte,
verschiedene Mitarbeiter aus. Deshalb **explizit als Vermutung markiert**, nie
als Behauptung, und nirgends ins Leaderboard oder in Ränge eingemischt.

**Warum nur ein Muster, kein Beweis:** Bitcoin/Glassnode können Adressen über
die „Common-Input-Ownership"-Heuristik verlässlich zusammenfassen (mehrere
Inputs einer Transaktion gehören fast immer demselben Besitzer). Auf einer
EVM-Chain wie dieser gibt es diesen Trick nicht — ein Wallet ist ein Wallet,
ohne kombinierbare Inputs. [`src/clusters.js`](src/clusters.js) wertet daher
nur ein einziges, schwächeres Signal aus: von wem ein Wallet den größten Teil
seines je erhaltenen ETN hat.

**Methode:** Analysiert werden die **Top 1.000** Wallets nach Balance (nicht
alle Fast-Tier-Wallets) — das hält den Lauf bei 8-12 Minuten und konzentriert
sich auf die Fälle, in denen ein Cluster überhaupt etwas bedeutet: zwei
Wallets mit ein paar hundert Dollar zu gruppieren ist kein nennenswerter Fund.
Pro Wallet werden bis zu 6 Seiten eingehender Transaktionen von
`blockexplorer.electroneum.com` geholt (`/addresses/{hash}/transactions?filter=to`
— ausschließlich diese eine Quelle, siehe [„Rücksicht auf den Explorer"](#rücksicht-auf-den-explorer)).

**Börsen und die Bridge zählen nie als Finanzierungsquelle**, auch nicht
teilweise — sonst wären alle Kunden derselben Börse fälschlich „ein Cluster",
nur weil sie zufällig von dort abgehoben haben. Das ist keine Beziehung
zwischen den Wallets, sondern reines Rauschen und wird vor der Auswertung
herausgefiltert, nicht erst am Ergebnis.

War die Historie eines Wallets länger als die 6 Seiten, wird das Ergebnis
**verworfen statt geraten** — genau das betrifft ohnehin meist Dienste, keine
echten Cluster-Kandidaten. Wallets mit ≥ 2 Mitgliedern und ≥ 60 % Anteil
derselben (nicht-Börsen-)Quelle werden als Gruppe gemeldet.

**„Run cluster analysis now"**: wie der Census manuell auslösbar, dauert
8-12 Minuten bei den Top 1.000, mittwochs automatisch (`.github/workflows/clusters.yml`).

**Mögliche Erweiterung** (noch nicht gebaut): weitere Muster wie „Wallets, die
nur miteinander interagieren" oder „im selben Block entstanden" — jedes
zusätzliche Signal bräuchte eigene Abwägung von Aussagekraft gegen
API-Kosten, siehe [`src/clusters.js`](src/clusters.js) für den Ansatzpunkt.

---

## Automatische Exchange-Erkennung

Beantwortet nur **„verhält sich das wie eine Börse?"**, nicht **„welche Börse
ist das?"** — für Letzteres gibt es keine automatisierbare Quelle. Selbst die
drei bereits bekannten Adressen (KuCoin, HTX, Biconomy) tragen im Explorer
**kein einziges Namens-Tag** (gegengeprüft über `public_tags`/`private_tags`),
und CoinMarketCap listet nur, *wo* ETN gehandelt wird — nicht die
Wallet-Adressen der Börsen auf der Electroneum Smart Chain. Der echte Name
bleibt darum immer Handarbeit über [`labels.json`](labels.json).

**Vier Verhaltens-Signale** (aus [`src/exchange-detect.js`](src/exchange-detect.js)),
zu einem Score 0–1 gewichtet:

| Signal | Gewicht | Idee |
|---|---|---|
| Gegenpartei-Vielfalt | 40 % | eine Person hat wenige, eine Börse Tausende verschiedene Gegenparteien |
| Transaktionszahl | 25 % | `tx_count` relativ zu einer Schwelle |
| Beidseitiger **Wert**fluss | 20 % | nicht nur *ob* beide Richtungen vorkommen, sondern ob sich auch der **Wert** die Waage hält (min/max von Ein- und Ausgangssumme) |
| Zeitliche Streuung | 15 % | Börsen sind 24/7 aktiv, Menschen eher gebündelt |

Getestet gegen die drei bekannten Börsen (Score je **1,00**) und zwei normale
Top-Whale-Wallets (Score je **0,01**) — saubere Trennung, kein Zufallsergebnis.

**Wichtiger Vorbehalt — Team-/Treasury-Wallets:** Eine Wallet, die einmalig
groß befüllt wird und danach an viele Empfänger auszahlt (z. B. eine
Team-Treasury oder ein Reward-Ausschüttungs-Wallet), hat ebenfalls hohe
Gegenpartei-Vielfalt und Transaktionszahl — sieht auf den ersten Blick wie
eine Börse aus, ist aber keine. Der Wert**balance**-Anteil des dritten
Signals fängt genau das ab: Börsen haben Zu- und Abfluss etwa im
Gleichgewicht (Durchlaufbetrieb), eine Team-Wallet bewegt in eine Richtung
deutlich mehr Wert als in die andere. Getestet: zwei Wallets mit hoher
Gegenpartei-Zahl, aber Wertbalance nahe 0 (fast nur eine Richtung), fielen
nach dieser Verfeinerung korrekt aus den Treffern. **Contracts werden
grundsätzlich nie automatisch als Börse markiert** (Staking-/Vesting-/
Reward-Contracts können dasselbe Fan-out-Muster zeigen). Trotzdem: der Score
bleibt eine Verhaltens-Vermutung, keine Identität — von Hand prüfen, bevor
daraus ein echter Name in `labels.json` wird.

Ab **Score ≥ 0,7** wird automatisch `label_type='service'`,
`label_source='auto'` gesetzt — aber **nie** ein bereits vorhandenes Label
überschrieben (weder ein manueller Eintrag noch ein früherer Auto-Fund). Im
Leaderboard erscheint das als eigenes Badge **„🔍 Unknown Exchange NN%"**,
optisch getrennt vom bestätigten „Exchange"-Tag, und zählt genauso wie
Börsen/Bridge zum Filter „Real wallets only".

**„Detect exchanges"**-Knopf: wie Census/Cluster-Analyse auslösbar, prüft die
Top 500 noch ungelabelten Wallets (Contracts ausgenommen), dauert ~15-20
Minuten, freitags automatisch (`.github/workflows/exchange-detect.yml`).

---

## Große Migrations-Ereignisse (Bridge Events)

Beantwortet die Frage „an welchem Tag ist ungewöhnlich viel ETN migriert
worden, und wohin?" Zwei Schritte, siehe [`src/bridge-events.js`](src/bridge-events.js):

1. **Ausreisser-Tage finden** — kostenlos, reine Berechnung aus der bereits
   vorhandenen Tages-Historie der Bridge (`daily_balances`): ein Tag zählt als
   Ausreisser, wenn der Abfluss > 3× den Median der Vergleichstage ist
   (Median statt Durchschnitt, damit ein einzelner Riesentag die Schwelle
   nicht selbst anhebt).
2. **Empfänger nachschlagen** — die Bridge selbst hat keine normalen
   Top-Level-Transaktionen, sie bewegt ETN ausschliesslich über **interne**
   Transaktionen (`fetchInternalTransactions` in
   [`src/blockscout.js`](src/blockscout.js)). Ein **einziger gemeinsamer**
   Durchlauf paginiert so weit zurück wie für den ältesten zu analysierenden
   Ausreisser nötig, statt pro Tag neu ab Seite 1 zu starten — das war der
   ursprüngliche Ansatz, kostete aber ein Vielfaches an Anfragen und reichte
   trotzdem nie weit genug zurück.

**Ehrliche Unvollständigkeit statt falscher Nullen:** die Bridge ist deutlich
aktiver als ursprünglich angenommen (~2.000 echte Transfers allein in vier
Wochen) — der Seitendeckel (`MAX_SEITEN_GESAMT`) reicht darum nicht
zuverlässig bis zum ältesten Tag im 90-Tage-Fenster zurück. Statt einen nicht
erreichten Tag fälschlich als „0 Empfänger" zu melden, markiert die Analyse
ihn als `unvollstaendig` (Spalte in `bridge_events`) — das Dashboard zeigt
dafür einen eigenen Hinweis statt einer Zahl.

**„Scan for events now"**-Knopf im Migration-Watch-Bereich: wie
Census/Cluster-Analyse/Exchange Detection auslösbar, analysiert die 8
größten Ausreisser der letzten 90 Tage, dauert je nach Bridge-Aktivität bis
zu ~15-20 Minuten, montags automatisch (`.github/workflows/bridge-events.yml`).

---

## Exchange-Netto-Fluss

Wandert ETN auf die Börsen oder von ihnen herunter? Rechnet die täglichen
Balance-Änderungen aller gelabelten Börsen-Wallets zusammen
(`exchange_flow` in [`src/index.js`](src/index.js), Reiter „Activity"):

- **Positiv** = ETN ist auf die Börsen gewandert. Wird üblicherweise als
  Verkaufsbereitschaft gelesen.
- **Negativ** = ETN hat die Börsen verlassen, typischerweise in
  Eigenverwahrung.

Diese Lesart ist eine Konvention, keine Regel — im Dashboard steht der
Vorbehalt neben der Zahl, und es bleibt bei der Beobachtung statt einer
Prognose.

**Kostet nichts extra:** rechnet ausschließlich auf `daily_balances`, das der
Backfill und der 30-Minuten-Ingest ohnehin füllen. Keine einzige zusätzliche
API-Anfrage.

**Zur Genauigkeit:** `daily_balances` enthält nur Tage mit Änderung, die
Differenz wird darum immer gegen die vorherige vorhandene Zeile derselben
Adresse gebildet (Lücke = keine Bewegung) — und über `balance_wei`/BigInt,
nie über die gerundete REAL-Spalte.

**Zur Abdeckung — der wichtigste Vorbehalt:** gezählt werden kann nur, was
gelabelt ist. Aktuell sind das drei bestätigte Börsen (KuCoin, HTX,
Biconomy); unbekannte Börsen-Wallets fehlen in den Zahlen zwangsläufig. Das
Dashboard schreibt die gezählte Anzahl darum immer dazu. Ein Schalter nimmt
zusätzlich die per Verhalten erkannten Kandidaten dazu (siehe
„Automatische Exchange-Erkennung") — die sind unbestätigt und entsprechend
markiert.

---

## Telegram-Weckalarm

Optional, siehe [`src/telegram.js`](src/telegram.js). Beantwortet „benachrichtige
mich, wenn dieses Wallet nach langer Ruhe wieder aktiv wird" — nutzt das
bereits vorhandene `sleeper_wake`-Ereignis (entsteht beim Ingest, siehe
`SLEEPER_DAYS` in [`src/ingest.js`](src/ingest.js)), keine eigene Erkennung.

**Zwei Hälften:**

1. **Webhook** (`/api/telegram/webhook`, im Worker) — nimmt `/watch 0xAdresse`,
   `/unwatch 0xAdresse`, `/mywatch` und `/stop` entgegen, unproblematisch
   fürs 10-ms-CPU-Limit (seltene, kurze Anfragen). Auch als Deep-Link
   nutzbar: `t.me/<Bot>?start=<Adresse ohne 0x>` startet direkt ein `/watch`
   — genau das verlinkt der „🔔 Alert me"-Knopf auf der Investigate-Seite.
2. **Versand** (`benachrichtigeSleeperWakes`, im Ingest-Job) — läuft
   bewusst NICHT im Worker, sondern in der GitHub Action, die ohnehin schon
   alle 30 Minuten läuft und dort die frischen `sleeper_wake`-Ereignisse
   kennt. Kein eigener Cron nötig, kein zusätzliches CPU-Risiko.

**Einrichtung** (komplett optional — ohne gesetztes `TELEGRAM_BOT_TOKEN`
bleibt das Feature einfach unsichtbar, nichts bricht):

1. Bot bei [@BotFather](https://t.me/BotFather) anlegen, Token als Secret setzen:
   `npx wrangler secret put TELEGRAM_BOT_TOKEN`
2. Bot-Benutzername (ohne `@`) in `wrangler.toml` bei `TELEGRAM_BOT_USERNAME`
   eintragen — öffentlich, dient nur dem Deep-Link-Button.
3. Optional ein zufälliges Secret gegen gefälschte Webhook-Aufrufe:
   `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`
4. Webhook einmalig bei Telegram registrieren:
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/api/telegram/webhook&secret_token=<Secret aus Schritt 3>`

Deckel: maximal 15 beobachtete Adressen pro Chat, gegen Tippfehler-Spam.

---

## API

| Endpoint | Zweck |
|---|---|
| `/api/overview` | Kopfzahlen, Migration, Tier-Verteilung, Bridge-Verlauf |
| `/api/leaderboard?limit&offset&period&tier&min_etn&max_etn&nur_wallets=1` | Rangliste |
| `/api/movers?period=24h\|7d\|30d\|90d\|6m\|1y` | größte Zu- und Abflüsse |
| `/api/sleepers?min_etn&min_tage` | lange unbewegte Wallets |
| `/api/events?type&min_severity` | erkannte Ereignisse |
| `/api/exchange-flow?period&incl_auto=1` | Netto-Fluss der Börsen-Wallets |
| `/api/wallet/0x…` | Detail inkl. Verlauf |
| `/api/search?q=` | Adresse, Label oder `.etn`-Name; unbekannte Adressen live vom Explorer |
| `/api/clusters` | Cluster-Vermutungen (Finanzierungsquellen-Gruppen) |
| `/api/bridge-events` | Große Migrations-Tage samt Top-Empfängern |
| `/api/census/status`, `/api/clusters/status`, `/api/exchanges/status`, `/api/bridge/status` | Sperrzustand der manuellen Trigger |
| `/api/census/trigger`, `/api/clusters/trigger`, `/api/exchanges/trigger`, `/api/bridge/trigger` (POST) | Job jetzt auslösen (24h-Sperre) |
| `/api/telegram/webhook` (POST) | Telegram-Bot-Updates, siehe „Telegram-Weckalarm" |

---

## Investigate-Tab (Wallet-Detailseite)

Eigener fünfter Reiter, kein Popup: Suchfeld für Adresse/Label/`.etn`-Name,
darunter volles Profil — Tier-Fortschritt, Balance-Chart über die Zeit,
Cluster-Bezug (wer hat dieses Wallet finanziert / wen finanziert es selbst),
alle bekannten Ereignisse. Erreichbar auf drei Wegen:

1. Direkt über den Tab und das eigene Suchfeld.
2. **Rechtsklick** auf eine Adresse irgendwo im Dashboard (Leaderboard, Movers,
   Sleeper Watch, Cluster-Mitglieder) → eigenes Kontextmenü → „🔎 Investigate
   this wallet" → springt zum Tab und lädt sofort.
3. **Linksklick** auf dieselben Adressen bleibt unverändert und führt direkt
   zum externen Blockscout-Explorer — der Rechtsklick ergänzt das, ersetzt es nicht.

Ein Wallet außerhalb der verfolgten Top N wird live beim Explorer nachgeschlagen
(Tier/Balance ja, Verlauf/Ereignisse/Cluster nein — dafür fehlt die lokale Historie).

## Leaderboard: Balance-Filter & Seitensprung

Über der Tabelle: Mindest-/Höchstbetrag in ETN eintragen und **Apply**, oder
einen der Presets nutzen (`< 100K`, `100K–500K`, `500K–2M`, `2M–10M`, `10M+`).
Neben „Previous/Next" ein Feld für die Seitenzahl direkt springen, statt sich
durchzuklicken — zeigt auch „page X/Y" zur Orientierung.

---

## Noch offen

Die ursprüngliche Ideenliste ist abgearbeitet. Was bewusst NICHT gebaut wurde
und warum:

- **Migrations-Risiko-Score pro Wallet** — nicht baubar. Es bräuchte die
  Sicht auf die alte Chain (wer hat dort noch wie viel liegen), und dorthin
  gibt es keinen Zugang. Alles, was hier ginge, wäre geraten und würde so
  aussehen, als wäre es gemessen.
- **Weitere Cluster-Muster** (nur miteinander interagierende Wallets, im
  selben Block entstanden) — jedes zusätzliche Signal kostet API-Anfragen und
  müsste seine Aussagekraft erst rechtfertigen, siehe
  [`src/clusters.js`](src/clusters.js).

Was mit reiner Handarbeit besser wird, ohne Code: mehr Börsen in
[`labels.json`](labels.json) eintragen. Jede bestätigte Börse verbessert
sowohl den Netto-Fluss (unten) als auch den Filter „Real wallets only".

---

Nicht mit Electroneum Ltd. verbunden. Keine Anlageberatung.
