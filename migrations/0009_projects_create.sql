CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_user ON projects(user_id, created_at);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  current_version_id TEXT REFERENCES workflow_versions(id),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('webhook','cron','both')),
  cron_expr TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_fired_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_workflows_project ON workflows(project_id, created_at);

CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_ts TEXT NOT NULL,
  deploy_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK(created_by IN ('user','heal')),
  parent_version_id TEXT REFERENCES workflow_versions(id),
  healed_from_run_id TEXT REFERENCES runs(id),
  UNIQUE(workflow_id, version)
);
CREATE INDEX idx_workflow_versions_workflow ON workflow_versions(workflow_id, version);
