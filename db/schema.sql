-- Runely D1 schema — the single source of truth while we're prototyping.
-- No migration tracking, no in-place alters: when the schema changes, wipe
-- the database and re-apply this file. Apply with:
--
--   bunx wrangler d1 execute taskcompiler-dev --remote --file db/schema.sql
--
-- The user/session/account/verification tables match Better Auth's default
-- SQLite shape; the rest are Runely's.

-- Better Auth ---------------------------------------------------------------

CREATE TABLE user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX idx_session_user ON session(user_id);
CREATE INDEX idx_session_expires ON session(expires_at);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_account_user ON account(user_id);
CREATE UNIQUE INDEX idx_account_provider ON account(provider_id, account_id);

CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX idx_verification_identifier ON verification(identifier);

-- Runely --------------------------------------------------------------------

-- `user_id` is the creator's id and stays as attribution. Access checks go
-- through `project_members` (flat power model — every member is equal-power;
-- `role` is forward-compat for differentiated permissions).
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_user ON projects(user_id, created_at);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','editor')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_project_members_user ON project_members(user_id, created_at);

CREATE TABLE project_invites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES user(id),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked','expired')),
  role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('admin','editor')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_project_invites_email ON project_invites(email, project_id);
CREATE INDEX idx_project_invites_token ON project_invites(token);

-- Event sources are the base trigger definition — a webhook URL or cron
-- schedule. Events are persisted per source (not per workflow) and fanned out
-- to every workflow attached. This enables parallel workflows on a single
-- event stream (graceful handover, A/B, backfill of new workflows against
-- captured history).
CREATE TABLE event_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('webhook','cron')),
  cron_expr TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_fired_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_event_sources_project ON event_sources(project_id, created_at);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_source_id TEXT NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  current_version_id TEXT REFERENCES workflow_versions(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  paused_at INTEGER,
  paused_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_workflows_project ON workflows(project_id, created_at);
CREATE INDEX idx_workflows_event_source ON workflows(event_source_id);

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

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  event_source_id TEXT NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('webhook','cron','manual','replay')),
  payload_json TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '{}',
  received_at INTEGER NOT NULL,
  dedup_key TEXT
);
CREATE INDEX idx_events_source_time ON events(event_source_id, received_at);

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
-- Strict 1-heal-per-workflow concurrency. The executor's atomic INSERT
-- doubles as the lock: a unique-constraint violation means another heal
-- is already running for that workflow, and the executor skips spawning.
-- Once a session terminates (status != 'running'), the row falls out of
-- the partial index, freeing the slot for the next heal.
CREATE UNIQUE INDEX idx_heal_sessions_one_running_per_workflow
  ON heal_sessions(workflow_id) WHERE status = 'running';

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
