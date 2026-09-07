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
