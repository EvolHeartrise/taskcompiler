-- A workflow now has exactly one trigger type — webhook OR cron, not both.
-- Rebuilds workflows with a narrower CHECK and maps any existing 'both' rows
-- to 'cron' if a cron expression was set (those were actually wired for cron),
-- otherwise to 'webhook'.
--
-- SQLite can't ALTER a CHECK in place, so we rename → recreate → copy → drop.
-- Child tables (workflow_versions, runs, events, heal_sessions, workflow_state)
-- have FKs to workflows(id); defer_foreign_keys keeps them satisfied across
-- the swap since we re-insert the same ids.

PRAGMA defer_foreign_keys = TRUE;

ALTER TABLE workflows RENAME TO workflows_old;

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  current_version_id TEXT REFERENCES workflow_versions(id),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('webhook','cron')),
  cron_expr TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_fired_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO workflows (id, project_id, name, prompt, current_version_id, trigger_type, cron_expr, created_at, updated_at, last_fired_at)
SELECT
  id, project_id, name, prompt, current_version_id,
  CASE
    WHEN trigger_type = 'both' AND cron_expr IS NOT NULL THEN 'cron'
    WHEN trigger_type = 'both' THEN 'webhook'
    ELSE trigger_type
  END,
  cron_expr, created_at, updated_at, last_fired_at
FROM workflows_old;

DROP TABLE workflows_old;

CREATE INDEX idx_workflows_project ON workflows(project_id, created_at);
