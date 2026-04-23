CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('webhook','cron','manual','replay')),
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  dedup_key TEXT
);
CREATE INDEX idx_events_workflow_time ON events(workflow_id, received_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
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
CREATE INDEX idx_runs_workflow_status ON runs(workflow_id, status);
CREATE INDEX idx_runs_event ON runs(event_id);

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

CREATE TABLE workflow_state (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, key)
);

CREATE TABLE project_secrets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);
CREATE INDEX idx_project_secrets_project ON project_secrets(project_id);
