-- Tracks the most recent cron fire timestamp per workflow.
-- Default 0 = never fired; the cron handler treats 0 as "fire on first matching tick".
ALTER TABLE workflows ADD COLUMN last_fired_at INTEGER NOT NULL DEFAULT 0;
