-- Enforce strict 1-heal-per-workflow concurrency at the DB level.
-- The executor will treat a unique-constraint violation on heal_sessions
-- INSERT as "another heal is already in flight; skip spawning". After a
-- session terminates (status != 'running'), the row falls out of the
-- partial index, so a subsequent heal for the same workflow can claim
-- the slot.
--
-- The previous executor-level guard (`getActiveHealSession` then
-- `WORKFLOW.create`) had a race window where two simultaneous failures
-- could both spawn — see commit removing that comment in the same PR.
CREATE UNIQUE INDEX IF NOT EXISTS idx_heal_sessions_one_running_per_workflow
  ON heal_sessions(workflow_id) WHERE status = 'running';
