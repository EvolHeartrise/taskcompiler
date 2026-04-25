-- Granular per-project permissions: widen project_members.role from
-- ('owner','member') to ('owner','admin','editor') and add a role column
-- to project_invites. Existing 'member' rows are remapped to 'editor'.
--
-- SQLite cannot drop or change a CHECK constraint in place, so we use the
-- canonical recreate-and-copy pattern: create new table, copy rows (with
-- the role remap), drop the old table, rename. All foreign-key cascades and
-- indexes are recreated on the new tables.
--
-- D1 does not support multi-statement BEGIN/COMMIT inside `wrangler d1
-- execute --file=...` (each statement runs in its own auto-commit). That's
-- consistent with how 002_project_members_and_invites.sql is structured —
-- no explicit transaction wrapper.

-- 1. project_members: widen role check + remap 'member' -> 'editor'.
CREATE TABLE project_members_new (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','editor')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

INSERT INTO project_members_new (project_id, user_id, role, created_at)
SELECT
  project_id,
  user_id,
  CASE role
    WHEN 'owner'  THEN 'owner'
    WHEN 'admin'  THEN 'admin'
    WHEN 'editor' THEN 'editor'
    WHEN 'member' THEN 'editor'
    ELSE 'editor'
  END,
  created_at
FROM project_members;

DROP TABLE project_members;
ALTER TABLE project_members_new RENAME TO project_members;
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id, created_at);

-- 2. project_invites: add role column + CHECK ('admin','editor'); backfill
--    existing rows to 'editor'. Recreate-and-copy pattern again because we
--    want the CHECK constraint enforced from the start.
CREATE TABLE project_invites_new (
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

INSERT INTO project_invites_new
  (id, project_id, email, token, invited_by, status, role, expires_at, created_at)
SELECT
  id, project_id, email, token, invited_by, status, 'editor', expires_at, created_at
FROM project_invites;

DROP TABLE project_invites;
ALTER TABLE project_invites_new RENAME TO project_invites;
CREATE INDEX IF NOT EXISTS idx_project_invites_email ON project_invites(email, project_id);
CREATE INDEX IF NOT EXISTS idx_project_invites_token ON project_invites(token);
