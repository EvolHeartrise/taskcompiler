-- Introduce per-user projects. Workflows and secrets are now scoped to a
-- project instead of directly to a user. Existing rows are testing data
-- only and discarded.
--
-- Split into 0008/0009 to keep each migration under D1's ~5s per-migration
-- timeout (see CLAUDE memory: ~12 ops max per file).

PRAGMA defer_foreign_keys = TRUE;

DROP TABLE IF EXISTS workflow_state;
DROP TABLE IF EXISTS heal_sessions;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS workflow_versions;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS workflows;
DROP TABLE IF EXISTS user_secrets;
