-- One-shot "reset the prototype database" SQL. Drops every table Runely
-- touches — including Better Auth's and wrangler's old migration tracking —
-- so `db/schema.sql` can be applied afterwards against a clean slate.
--
--   bunx wrangler d1 execute runely-dev --remote --file db/wipe.sql
--   bunx wrangler d1 execute runely-dev --remote --file db/schema.sql
--
-- Safe to run repeatedly (all drops are IF EXISTS). Will sign out every
-- existing user (session table goes with it). Don't use against a database
-- that has real data.

PRAGMA defer_foreign_keys = TRUE;

DROP TABLE IF EXISTS workflow_state;
DROP TABLE IF EXISTS heal_sessions;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS workflow_versions;
DROP TABLE IF EXISTS project_secrets;
DROP TABLE IF EXISTS workflows;
DROP TABLE IF EXISTS event_sources;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS verification;
DROP TABLE IF EXISTS user;
DROP TABLE IF EXISTS d1_migrations;
