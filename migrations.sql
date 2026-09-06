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
