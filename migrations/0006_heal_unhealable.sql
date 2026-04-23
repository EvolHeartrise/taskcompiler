-- Rebuild heal_sessions with `needs_attention`/`resolved` states and
-- columns for the heal agent's unhealable verdict. Existing rows are
-- discarded (test data only).

PRAGMA defer_foreign_keys = TRUE;

DROP TABLE IF EXISTS heal_sessions;

CREATE TABLE heal_sessions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  triggering_run_id TEXT NOT NULL REFERENCES runs(id),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','success','failed','abandoned','needs_attention','resolved')),
  diff TEXT,
  test_results_json TEXT,
  new_version_id TEXT REFERENCES workflow_versions(id),
  agent_transcript_json TEXT,
  unhealable_category TEXT,
  unhealable_reason TEXT,
  resolved_at INTEGER
);

CREATE INDEX idx_heal_sessions_workflow ON heal_sessions(workflow_id, started_at);
