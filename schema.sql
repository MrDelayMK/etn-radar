-- ETN Whale Tracker - D1 (SQLite) Schema
--
-- WICHTIG zu Betraegen: ETN-Balances kommen als Wei mit bis zu 28 Stellen
-- (Bridge: 8239046874000000000000000000). Das passt NICHT in einen SQLite
-- INTEGER (max ~9.2e18). Darum immer zwei Spalten:
--   balance_wei TEXT  -> exakter Wert, fuer Anzeige und Differenzen (BigInt)
--   etn         REAL  -> gerundet, nur zum Sortieren/Aggregieren
-- Niemals REAL fuer Betragsdifferenzen verwenden.

-- ---------------------------------------------------------------
-- Adressen. Sticky: einmal erfasst = dauerhaft verfolgt, auch wenn
-- die Adresse spaeter aus den Top N herausfaellt.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS addresses (
  hash            TEXT PRIMARY KEY,          -- 0x... IMMER lowercase
  checksum_hash   TEXT,                      -- Original-Schreibweise fuer die Anzeige
  first_seen      TEXT NOT NULL,             -- ISO8601 UTC
  last_seen       TEXT NOT NULL,             -- zuletzt in einem Snapshot gesehen
  is_contract     INTEGER NOT NULL DEFAULT 0,
  contract_name   TEXT,                      -- z.B. "ERC1967Proxy"
  impl_name       TEXT,                      -- z.B. "ETNBridge"
  ens_name        TEXT,                      -- z.B. "jesus.etn"

  -- Manuelle Kuratierung (dein wertvollstes Asset)
  label           TEXT,                      -- "Binance Hot Wallet", "Team Reserve"
  label_type      TEXT,                      -- exchange|bridge|team|contract|whale|service|unknown
  label_source    TEXT,                      -- manual|auto|explorer
  notes           TEXT,

  -- Heuristik
  exchange_score  REAL,                      -- 0.0 .. 1.0, siehe src/exchange-detect.js
  exchange_signale TEXT,                     -- JSON: welche Signale wie stark beigetragen haben
  score_reason    TEXT,                      -- JSON: welche Signale ausgeloest haben

  -- Aus dem "echten" Wallet-Ranking ausblenden (Bridge, Boersen)
  is_excluded     INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------
-- Ein Snapshot-Lauf (alle 6 Stunden)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at        TEXT NOT NULL UNIQUE,      -- ISO8601 UTC
  day             TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  block_number    INTEGER,
  total_supply    TEXT,                      -- Wei als TEXT
  bridge_wei      TEXT,                      -- noch nicht migrierte Legacy-Supply
  etn_price       REAL,
  addr_count      INTEGER,                   -- erfasste Adressen
  total_addresses INTEGER,                   -- Adressen auf der Chain insgesamt
                                             -- (noetig, um Plankton auszurechnen:
                                             --  alles, was unter der Erfassung liegt)
  changed_count   INTEGER,                   -- davon mit geaenderter Balance
  duration_ms     INTEGER,
  rows_written    INTEGER,                   -- gemessene Schreiblast des Laufs
  status          TEXT NOT NULL DEFAULT 'ok' -- ok|partial|failed
);
CREATE INDEX IF NOT EXISTS idx_snapshots_day ON snapshots(day);

-- ---------------------------------------------------------------
-- Balance-Historie in 6h-Aufloesung.
-- Nur Zeilen mit GEAENDERTER Balance werden geschrieben (der lange
-- Schwanz ist ueberwiegend statisch -> spart ~90% Schreiblast).
-- Lueckenlose Reihen entstehen per carry-forward beim Lesen.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS balances (
  snapshot_id     INTEGER NOT NULL,
  address         TEXT NOT NULL,
  rank_pos        INTEGER,                   -- Rang zum Snapshot-Zeitpunkt
  balance_wei     TEXT NOT NULL,
  etn             REAL NOT NULL,
  tx_count        INTEGER,
  delta_wei       TEXT,                      -- Differenz zum vorherigen Wert
  PRIMARY KEY (snapshot_id, address)
);
CREATE INDEX IF NOT EXISTS idx_balances_address ON balances(address, snapshot_id);

-- ---------------------------------------------------------------
-- Aktueller Stand, immer vollstaendig. Basis fuer das Leaderboard.
-- rank_pos wird beim Ingest gesetzt; fuer Ad-hoc-Sortierung reicht ORDER BY etn.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS current_balances (
  address         TEXT PRIMARY KEY,
  rank_pos        INTEGER,
  balance_wei     TEXT NOT NULL,
  etn             REAL NOT NULL,
  tx_count        INTEGER,
  tier            TEXT,                      -- humpback|whale|shark|...
  updated_at      TEXT NOT NULL,             -- letzte Balance-AENDERUNG
  last_snapshot   INTEGER,                   -- zuletzt im Snapshot enthalten
  in_top_n        INTEGER NOT NULL DEFAULT 1 -- 0 = aus den Top N gefallen
);
CREATE INDEX IF NOT EXISTS idx_current_etn ON current_balances(etn DESC);
CREATE INDEX IF NOT EXISTS idx_current_tier ON current_balances(tier);

-- ---------------------------------------------------------------
-- Tagesverlauf. Gefuellt aus dem 90-Tage-Backfill (Blockscout
-- coin-balance-history-by-day) und laufend aus den Snapshots.
-- Basis fuer alle Charts und Sparklines.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_balances (
  address         TEXT NOT NULL,
  day             TEXT NOT NULL,             -- YYYY-MM-DD
  balance_wei     TEXT NOT NULL,
  etn             REAL NOT NULL,
  source          TEXT NOT NULL DEFAULT 'snapshot', -- backfill|snapshot
  PRIMARY KEY (address, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_balances(day);

-- ---------------------------------------------------------------
-- Netzwerkweite Tageswerte (fuer die Kopfkacheln)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS network_daily (
  day             TEXT PRIMARY KEY,
  total_supply    TEXT,
  bridge_wei      TEXT,
  circulating_wei TEXT,
  etn_price       REAL,
  holders_1m      INTEGER,                   -- Wallets >= 1M ETN
  holders_5m      INTEGER,
  holders_10m     INTEGER,
  top10_share     REAL,                      -- Anteil an zirkulierender Menge
  top100_share    REAL,
  top1000_share   REAL
);

-- ---------------------------------------------------------------
-- Tiefenzaehlung fuer die unteren Tiers (Crab bis Dust).
--
-- Laeuft woechentlich statt alle 6h und speichert bewusst NUR Summen, keine
-- einzelnen Wallet-Zeilen: bei geschaetzt 150.000+ Adressen unterhalb von
-- 500.000 ETN waere das reiner Speicherballast fuer Wallets im Wert von
-- Cent-Betraegen, die niemand einzeln nachverfolgt. Einzelne Adressen bleiben
-- trotzdem über /api/search nachschlagbar (Live-Fallback zum Explorer).
--
-- Dust (< 5.000 ETN) wird nie gezaehlt, sondern als Rest aus
-- snapshots.total_addresses minus allem nachweislich Darueberliegenden
-- berechnet - das passiert erst beim Lesen (src/index.js), nicht hier.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tier_census (
  day             TEXT NOT NULL,             -- YYYY-MM-DD
  tier            TEXT NOT NULL,             -- crab|shrimp|plankton|microbe
  count           INTEGER NOT NULL,          -- Wallets in dieser Stufe
  etn_sum         REAL NOT NULL,             -- Summe ihrer Balancen
  PRIMARY KEY (day, tier)
);

-- Sperr-Zustand fuer manuelle "Jetzt ausfuehren"-Knoepfe (Census,
-- Cluster-Analyse, ...). Getrennt von den jeweiligen *_runs-Tabellen (die
-- erst beim FERTIGEN Lauf geschrieben werden): ohne eigene Sperre koennte man
-- waehrend der 20+ Minuten Laufzeit mehrfach ausloesen.
CREATE TABLE IF NOT EXISTS job_control (
  name              TEXT PRIMARY KEY,   -- 'census' | 'clusters'
  last_triggered_at TEXT
);

-- Ergebnis der Finanzierungsquellen-Analyse pro Wallet (Cluster-Vermutungen).
-- Nur fuer individuell verfolgte (Fast-Tier-)Wallets, siehe src/clusters.js.
-- Absichtlich NICHT gespeichert, wenn die Historie laenger war als geprueft
-- (capped) - lieber kein Ergebnis als eines aus einem unvollstaendigen
-- Ausschnitt.
CREATE TABLE IF NOT EXISTS wallet_funding (
  address           TEXT PRIMARY KEY,
  funding_source    TEXT,          -- Adresse mit dem groessten Anteil am je erhaltenen Betrag
  funding_share     REAL,          -- deren Anteil, 0..1
  inbound_wei_total TEXT,          -- Summe aller analysierten Eingaenge (Wei)
  inbound_count     INTEGER,       -- Anzahl analysierter Eingangs-Transaktionen
  pages_checked     INTEGER,
  capped            INTEGER NOT NULL DEFAULT 0,
  computed_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_funding_source ON wallet_funding(funding_source);

CREATE TABLE IF NOT EXISTS cluster_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at        TEXT NOT NULL,
  day             TEXT NOT NULL,
  wallets_geprueft INTEGER,
  quellen_gefunden INTEGER,
  zu_aktiv        INTEGER,          -- Wallets mit gedeckelter (unvollstaendiger) Historie
  duration_ms     INTEGER,
  status          TEXT NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS exchange_detect_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at        TEXT NOT NULL,
  day             TEXT NOT NULL,
  wallets_geprueft INTEGER,
  erkannt         INTEGER,          -- Score >= Schwelle, automatisch als 'service' markiert
  duration_ms     INTEGER,
  status          TEXT NOT NULL DEFAULT 'ok'
);

-- Grosse Migrations-Tage (Bridge-Abfluss-Ausreisser) und wer das Geld erhalten
-- hat, siehe src/bridge-events.js. top_recipients ist JSON: [{address, etn}].
-- Rueckmeldungen von der Seite.
--
-- Absichtlich in D1 statt in einem eigenen KV-Speicher: das haette eine
-- weitere Bindung gebraucht, die man beim Aufsetzen vergessen kann. Das
-- Aufkommen ist ohnehin winzig - eine Zeile je Nachricht faellt gegen die
-- 100.000 Schreibzeilen am Tag nicht ins Gewicht.
--
-- ip_hash ist KEINE Adresse, sondern die ersten 16 Zeichen eines SHA-256 aus
-- IP und Tag. Genug, um "fuenf pro Stunde" durchzusetzen, und wertlos, um
-- jemanden zu identifizieren; nach einem Tag passt derselbe Absender ohnehin
-- auf einen anderen Hash.
CREATE TABLE IF NOT EXISTS feedback (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  nachricht TEXT NOT NULL,
  absender  TEXT,
  seite     TEXT,
  ip_hash   TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(ts);

-- Kurshistorie aus der Zeit VOR diesem Dashboard.
--
-- Der Kursverlauf wurde zuerst live bei jedem Aufruf von aussen geholt. Das
-- scheiterte nicht an der Programmierung, sondern an IP-Sperren: CoinGecko
-- antwortet Workern ohne User-Agent mit 403 und mit Kennung dann 429 (das
-- Gratis-Kontingent haengt an der IP, und Worker teilen sich ihre Adressen),
-- Coinpaprika weist sie mit 402 ab, waehrend dieselbe URL von einem
-- gewoehnlichen Anschluss 200 liefert.
--
-- Darum einmalig befuellt (scripts/price-backfill.mjs) und danach aus den
-- eigenen Snapshots weitergeschrieben: network_daily traegt den Tageskurs
-- ohnehin mit. Im Betrieb braucht die Seite damit gar keine fremde
-- Kursquelle mehr.
CREATE TABLE IF NOT EXISTS price_history (
  day   TEXT PRIMARY KEY,
  preis REAL NOT NULL
);

-- Die grossen Einzeltransfers der Bridge selbst, als Rohbestand.
--
-- Warum eine eigene Tabelle statt nur der Tagesbilanz in bridge_events:
-- die Historie der Bridge reicht bis zum 03.03.2024 zurueck und laesst sich
-- nur von der neuesten Seite aus rueckwaerts durchblaettern. Das ist ein Lauf
-- von rund zwei Stunden - jede Woche von vorn waere Unfug. Also wird der
-- Rohbestand hier gesammelt, der Lauf setzt beim naechsten Mal dort fort, wo
-- er aufgehoert hat (siehe bridge_scan), und bridge_events wird daraus jedes
-- Mal neu aufgebaut.
--
-- Aufgenommen wird nur, was ueber der Schwelle liegt (MIN_TRANSFER_ETN in
-- src/bridge-events.js). Alles darunter ist Alltagsverkehr und waeren
-- hunderttausende Zeilen ohne Aussage.
CREATE TABLE IF NOT EXISTS bridge_transfers (
  id          TEXT PRIMARY KEY,          -- Transaktions-Hash + Empfaenger + Betrag
  day         TEXT NOT NULL,
  timestamp   TEXT NOT NULL,
  to_address  TEXT NOT NULL,
  etn         REAL NOT NULL,
  value_wei   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bridge_transfers_day ON bridge_transfers(day);
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_etn ON bridge_transfers(etn);

-- Wie weit der Durchgang durch die Bridge-Historie gekommen ist. Genau eine
-- Zeile; der Cursor ist das next_page_params des Explorers, mit dem der
-- naechste Lauf exakt dort weitermacht, wo dieser aufgehoert hat.
CREATE TABLE IF NOT EXISTS bridge_scan (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  neuestes_bekannt  TEXT,                -- Zeitstempel des neuesten erfassten Transfers
  aeltestes_bekannt TEXT,
  cursor            TEXT,                -- next_page_params als JSON, NULL = noch nicht begonnen
  fertig            INTEGER NOT NULL DEFAULT 0,  -- 1 = bis zum Anfang der Bridge durch
  seiten_gesamt     INTEGER NOT NULL DEFAULT 0,
  aktualisiert_am   TEXT
);

CREATE TABLE IF NOT EXISTS bridge_events (
  day             TEXT PRIMARY KEY,
  outflow_etn     REAL NOT NULL,
  recipient_count INTEGER,
  top_recipients  TEXT,
  unvollstaendig  INTEGER NOT NULL DEFAULT 0, -- 1 = Suche kam nicht bis zu diesem Tag zurueck (Seitendeckel), 0 Empfaenger dann NICHT als Ergebnis werten
  analyzed_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bridge_event_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at        TEXT NOT NULL,
  day             TEXT NOT NULL,
  tage_gefunden   INTEGER,
  tage_analysiert INTEGER,
  zurueck_bis     TEXT,                      -- wie weit der Lauf tatsaechlich zurueckkam
  status          TEXT NOT NULL DEFAULT 'ok'
);

-- Telegram-Weckalarm-Abos: welcher Chat beobachtet welche Adresse. Siehe
-- src/telegram.js. Ein Chat kann mehrere Adressen beobachten, eine Adresse
-- kann von mehreren Chats beobachtet werden - darum der zusammengesetzte Key.
CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  chat_id     TEXT NOT NULL,
  address     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (chat_id, address)
);
CREATE INDEX IF NOT EXISTS idx_telegram_address ON telegram_subscriptions(address);

CREATE TABLE IF NOT EXISTS census_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at        TEXT NOT NULL,
  day             TEXT NOT NULL,
  depth_reached   INTEGER,                   -- Anzahl gepruefter Adressen
  lowest_balance  REAL,                      -- tiefste erreichte Balance
  pages           INTEGER,
  duration_ms     INTEGER,
  status          TEXT NOT NULL DEFAULT 'ok' -- ok|partial|failed
);

-- ---------------------------------------------------------------
-- Erkannte Ereignisse (speisen "Latest Signals" im Dashboard)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at     TEXT NOT NULL,
  snapshot_id     INTEGER,
  type            TEXT NOT NULL,
  -- gain | loss | rank_enter | rank_exit | tier_up | tier_down
  -- sleeper_wake | new_whale | drained | bridge_outflow
  address         TEXT,
  delta_wei       TEXT,
  delta_etn       REAL,
  delta_pct       REAL,
  rank_from       INTEGER,
  rank_to         INTEGER,
  tier_from       TEXT,
  tier_to         TEXT,
  severity        INTEGER NOT NULL DEFAULT 0, -- 0..100, fuer Sortierung
  meta            TEXT                        -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_addr ON events(address, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, detected_at DESC);

-- Hinweis: es gibt bewusst KEINE Tabelle fuer Transfer-Daten von Drittseiten.
-- Alle Daten dieses Projekts kommen ausschliesslich vom offiziellen Explorer
-- der Electroneum Smart Chain (blockexplorer.electroneum.com).

-- ===================================================================
-- Neue Spalte an einer BESTEHENDEN Tabelle?
--
-- Dann gehoert sie an ZWEI Stellen: oben ins CREATE TABLE (fuer frische
-- Datenbanken) UND als ALTER-Zeile nach migrations.sql (fuer alle, die es
-- schon gibt). CREATE TABLE IF NOT EXISTS aendert eine vorhandene Tabelle
-- naemlich nicht - die neue Spalte taucht dort sonst nie auf.
--
-- Warum getrennte Dateien: diese Datei muss mit `wrangler d1 execute --file`
-- durchlaufen. Wrangler bricht beim ersten Fehler ab, und ein
-- "ALTER TABLE ... ADD COLUMN" auf eine frische Datenbank ist immer ein
-- Fehler ("duplicate column name") - die Spalte steht ja schon im CREATE
-- TABLE. Damit war die dokumentierte Ersteinrichtung nicht durchfuehrbar.
-- ===================================================================

-- ---------------------------------------------------------------
-- Vorberechnete Kennzahlen fuer die Uebersicht.
--
-- Gemessen am 08.09.2026: /api/overview las 7.179 Zeilen pro Aufruf -
-- dreimal ein voller Durchlauf durch current_balances, um am Ende rund
-- zwanzig Zahlen anzuzeigen. Ein Index half nicht: in_top_n ist bei fast
-- allen Zeilen gleich, da muss die Datenbank ohnehin alles ansehen.
--
-- Der Snapshot-Lauf hat diese Zahlen ohnehin im Speicher. Er legt sie hier
-- als eine Zeile ab, der Worker liest sie. Aus 7.179 gelesenen Zeilen wird
-- eine. Genau daran riss am 08.09. das Tageslimit.
--
-- Als JSON, damit eine neue Kennzahl keine Schemaaenderung braucht - gelesen
-- wird der Block ohnehin immer am Stueck.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kennzahlen (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  daten        TEXT NOT NULL,             -- JSON-Block, siehe src/ingest.js
  snapshot_id  INTEGER,
  erstellt_am  TEXT NOT NULL
);

-- ---------------------------------------------------------------
-- Rang-Historie, ein Eintrag je Wallet und Tag.
--
-- Fuer "hat die Bewegung dem Wallet auch Plaetze gekostet". Der Rang ergibt
-- sich aus dem Vergleich mit ALLEN anderen und verschiebt sich auch dann,
-- wenn ein Wallet selbst nichts tut - er laesst sich darum nachtraeglich
-- nicht aus der Bestandshistorie ableiten. Er muss aufgehoben werden.
--
-- Nur beim ERSTEN Snapshot eines Tages geschrieben: 3.000 Zeilen taeglich,
-- rund 3% des Gratis-Schreibbudgets. Snapshot-genau waeren es 144.000 und
-- damit 144% - das ist die Genauigkeit nicht wert.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_ranks (
  address   TEXT NOT NULL,
  day       TEXT NOT NULL,               -- YYYY-MM-DD
  rank_pos  INTEGER NOT NULL,
  PRIMARY KEY (address, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_ranks_day ON daily_ranks(day);

-- ---------------------------------------------------------------
-- Bremse fuer die Live-Abfrage einzelner Wallets.
--
-- Wer ein Wallet aufschlaegt, bekommt den Bestand direkt vom Explorer statt
-- aus dem letzten Snapshot. Damit daraus kein Dauerfeuer auf fremde
-- Infrastruktur wird, zwei Sperren aus dieser einen Tabelle:
--
--   je Wallet   Innerhalb von LIVE_SPERRE_MS kein zweites Mal. Faengt den
--               Fall ab, dass hundert Leute denselben geteilten Link oeffnen -
--               das kostet EINE Anfrage, nicht hundert.
--   global      Hoechstens LIVE_PRO_MINUTE Abfragen fuer die ganze Seite.
--
-- Die Tabelle steht bewusst in D1 und nicht im Cache: der Cache liegt je
-- Rechenzentrum getrennt, ein Deckel darin waere keiner. Die Datenbank ist
-- eine Instanz - hier gilt die Grenze wirklich global, auch bei zehntausend
-- Besuchern.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_abrufe (
  address    TEXT PRIMARY KEY,
  geholt_am  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_abrufe_zeit ON live_abrufe(geholt_am);

-- Teilindex fuer den "Services only"-Filter: enthaelt nur die markierten
-- Adressen (rund zwanzig), nicht alle dreitausend. Ohne ihn muss die
-- Datenbank die nach Bestand sortierte Liste komplett durchgehen, um eine
-- Handvoll Treffer zu finden - gemessen 6.012 gelesene Zeilen statt 71.
CREATE INDEX IF NOT EXISTS idx_addresses_markiert ON addresses(hash)
  WHERE label_type IS NOT NULL OR is_excluded = 1 OR is_contract = 1;

-- ---------------------------------------------------------------
-- Kursmarken: Allzeithoch, Allzeittief, 12-Monats-Hoch.
--
-- ATH und ATL kommen EINMALIG von CoinGecko (05.01.2018 bzw. 14.08.2026).
-- Weiter zurueck als 365 Tage gibt keine kostenlose Kursquelle ihre
-- Tagesreihe heraus - geprueft am 08.09.2026: CoinPaprika 402, CryptoCompare
-- 401, CoinGecko 401 ab dem 366. Tag. Die fertigen ATH/ATL-Felder liefert
-- CoinGecko aber ohne Einschraenkung.
--
-- Danach pflegt der Snapshot-Lauf sie selbst weiter: Faellt der Kurs unter
-- das gespeicherte Tief oder steigt er ueber das Hoch, wird die Marke
-- fortgeschrieben. Damit braucht der Betrieb wieder keine fremde Quelle -
-- und das ist keine Theorie: Das Allzeittief stammt vom August 2026, ist
-- also frisch und kann jederzeit erneut unterboten werden.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kurs_marken (
  schluessel   TEXT PRIMARY KEY,          -- ath | atl | hoch_12m
  preis        REAL NOT NULL,
  tag          TEXT,                      -- YYYY-MM-DD
  quelle       TEXT,
  gesetzt_am   TEXT NOT NULL
);

-- ---------------------------------------------------------------
-- Besuche. Eine Zeile je Besuch, nicht je Klick.
--
-- Der Browser sammelt waehrend des Besuchs und schickt EINMAL beim Verlassen
-- eine Zusammenfassung. Bei tausend Besuchern am Tag sind das tausend
-- geschriebene Zeilen - je Klick waeren es Zehntausende, und das Gratis-
-- Schreibbudget sind 100.000 taeglich.
--
-- Wer gezaehlt wird: nur wer sich wirklich bewegt hat (Maus, Tastatur,
-- Scrollen, Tippen). Das schliesst Crawler und Aufwaerm-Anfragen aus, ohne
-- eine einzige Bot-Liste pflegen zu muessen - und auch die eigenen
-- Pruefabrufe, die nie eine Maus bewegen.
--
-- Wer NICHT erkennbar wird: besucher ist ein Kurz-Hash aus IP und TAG. Er
-- wechselt jede Nacht, laesst sich nicht zurueckrechnen und folgt niemandem
-- ueber Tage hinweg. Kein Cookie, kein localStorage, keine Kennung im Geraet.
-- Er reicht genau fuer "wie viele verschiedene Leute waren heute da" und fuer
-- nichts darueber hinaus. Genau dasselbe Verfahren bremst schon das
-- Feedback-Formular.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS besuche (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,             -- Ende des Besuchs
  tag          TEXT NOT NULL,             -- YYYY-MM-DD
  besucher     TEXT NOT NULL,             -- Kurz-Hash aus IP + Tag
  dauer_s      INTEGER NOT NULL,          -- aktive Zeit auf der Seite
  klicks       INTEGER NOT NULL DEFAULT 0,
  bereiche     TEXT,                      -- besuchte Reiter, kommagetrennt
  einstieg     TEXT,                      -- Reiter, mit dem begonnen wurde
  herkunft     TEXT,                      -- Referrer-Domain, ohne Pfad
  geraet       TEXT                       -- mobil | desktop
);
CREATE INDEX IF NOT EXISTS idx_besuche_tag ON besuche(tag);
CREATE INDEX IF NOT EXISTS idx_besuche_besucher ON besuche(tag, besucher);

-- ---------------------------------------------------------------
-- Eingefrorene Zustaende rund um den Migrations-Stichtag.
--
-- WARUM EINE EIGENE TABELLE, obwohl network_daily denselben Tag ohnehin
-- traegt: Der Stichtag kommt genau einmal. Faellt der Ingest an diesem Tag
-- aus, waere die Zeile fuer immer weg - und es gibt keinen zweiten Versuch.
-- Hier steht sie als Ganzes, unabhaengig davon, ob spaeter jemand
-- network_daily ausduennt oder eine Spalte umbaut.
--
-- Gefuellt wird NICHT rueckwirkend, sondern am jeweiligen Tag selbst aus dem
-- laufenden Snapshot (src/ingest.js, Abschnitt 7e). Der erste Marker (T-90)
-- faellt auf den 02.11.2026 - damit laeuft das Verfahren drei Monate lang im
-- Echtbetrieb, bevor es auf den einen Tag ankommt, der zaehlt.
--
-- ON CONFLICT DO NOTHING ist Absicht: ein einmal gesetzter Marker darf sich
-- nie mehr aendern, sonst waere "vorher" kein Vorher mehr.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stichtag (
  schluessel  TEXT PRIMARY KEY,          -- T-90 | T-30 | T-7 | T0 | T+7 | T+30 | T+90
  tag         TEXT NOT NULL,             -- YYYY-MM-DD, auf den sich der Marker bezieht
  daten       TEXT NOT NULL,             -- JSON, siehe src/ingest.js
  gesetzt_am  TEXT NOT NULL
);

-- Fuer die Top-Transfers der Bridge in der Bilanz. Ohne den Index waere jede
-- Anzeige ein voller Durchlauf durch bridge_transfers.
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_etn ON bridge_transfers(etn DESC);

-- Fuer "welche Wallets gibt es erst nach dem Stichtag". Ohne Index waere das
-- ein Durchlauf durch alle erfassten Adressen.
CREATE INDEX IF NOT EXISTS idx_addresses_first_seen ON addresses(first_seen);
