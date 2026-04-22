-- Fresh start for auth + tenancy. Drops all application tables (data is
-- intentionally discarded). New tables are created in 0004 and 0005.
--
-- Defer FK checks for the duration of this migration so circular-ish
-- refs (workflows.current_version_id <-> workflow_versions.workflow_id)
-- don't trip DELETE/DROP. D1 enables foreign_keys by default.

PRAGMA defer_foreign_keys = TRUE;

DROP TABLE IF EXISTS workflow_state;
DROP TABLE IF EXISTS heal_sessions;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS workflow_versions;
DROP TABLE IF EXISTS workflows;
