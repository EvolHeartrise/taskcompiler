CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  current_version_id TEXT REFERENCES workflow_versions(id),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('webhook','cron','both')),
  cron_expr TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  version INTEGER NOT NULL,
  source_ts TEXT NOT NULL,
  deploy_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK(created_by IN ('user','heal')),
  parent_version_id TEXT REFERENCES workflow_versions(id),
  healed_from_run_id TEXT REFERENCES runs(id),
  UNIQUE(workflow_id, version)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('webhook','cron','manual','replay')),
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  dedup_key TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  version_id TEXT NOT NULL REFERENCES workflow_versions(id),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','ok','failed','superseded')),
  error_json TEXT,
  result_json TEXT,
  logs_json TEXT,
  is_replay INTEGER NOT NULL DEFAULT 0,
  parent_run_id TEXT REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS heal_sessions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  triggering_run_id TEXT NOT NULL REFERENCES runs(id),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','success','failed','abandoned')),
  diff TEXT,
  test_results_json TEXT,
  new_version_id TEXT REFERENCES workflow_versions(id),
  agent_transcript_json TEXT
);

CREATE TABLE IF NOT EXISTS workflow_state (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, key)
);

CREATE INDEX IF NOT EXISTS idx_events_workflow_time ON events(workflow_id, received_at);
CREATE INDEX IF NOT EXISTS idx_runs_workflow_status ON runs(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_event ON runs(event_id);
CREATE INDEX IF NOT EXISTS idx_heal_sessions_workflow ON heal_sessions(workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow ON workflow_versions(workflow_id, version);
