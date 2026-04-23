-- Account-level secrets. A user's secrets are available to any of their
-- workflows as secret_text bindings on the WFP script. Values are never
-- exposed through the UI.

CREATE TABLE user_secrets (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE INDEX idx_user_secrets_user ON user_secrets(user_id);
