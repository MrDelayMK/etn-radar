-- Migrationen fuer BEREITS BESTEHENDE Datenbanken.
--
-- Nur noetig, wenn die Datenbank angelegt wurde, BEVOR eine dieser Spalten
-- existierte. Bei einer frischen Datenbank stehen sie schon im CREATE TABLE
-- in schema.sql - dann schlaegt hier jede Zeile mit "duplicate column name"
-- fehl, und genau das ist in Ordnung.
--
-- Anwenden:
--   npm run db:migrate          (remote, D1)
--   npm run db:migrate:local    (lokale SQLite-Datei)
--
-- Beide Wege gehen ueber scripts/apply-migrations.mjs, das jede Zeile
-- EINZELN ausfuehrt und "duplicate column name" stillschweigend ueberspringt,
-- jeden anderen Fehler aber weiterreicht. Bewusst nicht ueber
-- `wrangler d1 execute --file`: das bricht beim ersten Fehler ab.
--
-- Neue Spalte ergaenzt? Hier eine Zeile anhaengen UND oben in schema.sql ins
-- CREATE TABLE aufnehmen.

ALTER TABLE addresses ADD COLUMN exchange_signale TEXT;
ALTER TABLE bridge_events ADD COLUMN unvollstaendig INTEGER NOT NULL DEFAULT 0;
ALTER TABLE network_daily ADD COLUMN top1000_share REAL;
ALTER TABLE bridge_event_runs ADD COLUMN zurueck_bis TEXT;

-- Ab hier auch CREATE-Anweisungen: der Anwender (scripts/apply-migrations.mjs)
-- fuehrt jede Zeile einzeln aus, und CREATE ... IF NOT EXISTS ist auf einer
-- bestehenden Datenbank folgenlos. Dieselben Anweisungen stehen in schema.sql,
-- damit eine frische Datenbank sie gleich mitbekommt.
CREATE TABLE IF NOT EXISTS feedback (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  nachricht TEXT NOT NULL,
  absender  TEXT,
  seite     TEXT,
  ip_hash   TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(ts);
CREATE TABLE IF NOT EXISTS price_history (
  day   TEXT PRIMARY KEY,
  preis REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS bridge_transfers (
  id          TEXT PRIMARY KEY,
  day         TEXT NOT NULL,
  timestamp   TEXT NOT NULL,
  to_address  TEXT NOT NULL,
  etn         REAL NOT NULL,
  value_wei   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_day ON bridge_transfers(day);
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_etn ON bridge_transfers(etn);
CREATE TABLE IF NOT EXISTS bridge_scan (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  neuestes_bekannt  TEXT,
  aeltestes_bekannt TEXT,
  cursor            TEXT,
  fertig            INTEGER NOT NULL DEFAULT 0,
  seiten_gesamt     INTEGER NOT NULL DEFAULT 0,
  aktualisiert_am   TEXT
);
CREATE TABLE IF NOT EXISTS kennzahlen (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  daten        TEXT NOT NULL,             -- JSON-Block, siehe src/ingest.js
  snapshot_id  INTEGER,
  erstellt_am  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_ranks (
  address   TEXT NOT NULL,
  day       TEXT NOT NULL,               -- YYYY-MM-DD
  rank_pos  INTEGER NOT NULL,
  PRIMARY KEY (address, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_ranks_day ON daily_ranks(day);
CREATE TABLE IF NOT EXISTS live_abrufe (
  address    TEXT PRIMARY KEY,
  geholt_am  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_abrufe_zeit ON live_abrufe(geholt_am);

ALTER TABLE snapshots ADD COLUMN rows_written INTEGER;

CREATE INDEX IF NOT EXISTS idx_addresses_markiert ON addresses(hash) WHERE label_type IS NOT NULL OR is_excluded = 1 OR is_contract = 1;
CREATE TABLE IF NOT EXISTS kurs_marken (
  schluessel   TEXT PRIMARY KEY,          -- ath | atl | hoch_12m
  preis        REAL NOT NULL,
  tag          TEXT,                      -- YYYY-MM-DD
  quelle       TEXT,
  gesetzt_am   TEXT NOT NULL
);
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
