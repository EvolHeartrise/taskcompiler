-- Project-level collaboration: every project gets a membership table and an
-- invite table. The flat power model treats every member as equal-power; the
-- `role` column is forward-compat (owner/member) and `projects.user_id` is
-- preserved as creator attribution.
--
-- Access checks migrate from `WHERE user_id = ?` on `projects` to a JOIN
-- against `project_members`. The backfill below seeds one owner row per
-- existing project so deployed code keeps loading after this migration runs.

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id, created_at);

CREATE TABLE IF NOT EXISTS project_invites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES user(id),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked','expired')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_invites_email ON project_invites(email, project_id);
CREATE INDEX IF NOT EXISTS idx_project_invites_token ON project_invites(token);

-- Backfill: every existing project's creator becomes an owner-role member.
-- `INSERT OR IGNORE` makes the migration idempotent if re-run.
INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_at)
SELECT id, user_id, 'owner', created_at FROM projects;
