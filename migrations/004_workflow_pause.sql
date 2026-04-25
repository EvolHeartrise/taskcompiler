-- Add a manual-pause status + pause metadata to workflows. A paused workflow
-- continues to persist events (webhook + cron) but skips run creation and
-- invocation; resume sets status back to 'active' and clears metadata.
--
-- The workflows table has child FKs from workflow_versions, runs,
-- heal_sessions, and workflow_state, plus a circular self-ref via
-- workflows.current_version_id <-> workflow_versions.workflow_id. The
-- recreate-and-copy pattern for CHECK widening trips SQLite's foreign-key
-- check at DROP TABLE time, so ALTER TABLE ADD COLUMN is the safer path —
-- none of the existing columns need re-typing, only new columns are added
-- and they carry explicit defaults so existing rows remain valid.
--
-- D1 does not support multi-statement BEGIN/COMMIT inside `wrangler d1
-- execute --file=...`; each statement runs in its own auto-commit.

ALTER TABLE workflows
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK(status IN ('active','paused'));

ALTER TABLE workflows ADD COLUMN paused_at INTEGER;

ALTER TABLE workflows
  ADD COLUMN paused_by TEXT REFERENCES user(id) ON DELETE SET NULL;
