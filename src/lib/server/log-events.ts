// Canonical event-name vocabulary. Pass these (not freeform strings) as the
// first arg to `log.info` / `log.warn` / `log.error` so every call site
// filters cleanly in the Observability UI (`$.event = "run.started"`).
//
// Adding a new event: pick a dotted `<domain>.<past-tense-verb>` name, keep
// the total under ~30 so agents and humans can learn them by sight.

export const EVENTS = {
	// Lifecycle of a single run (one dispatched event → one workflow invocation).
	RUN_STARTED: 'run.started',
	RUN_COMPLETED: 'run.completed',
	RUN_FAILED: 'run.failed',

	// Dispatcher round-trips (WFP .get().fetch() to the user script).
	DISPATCH_RETRY: 'dispatch.retry',
	DISPATCH_FANOUT_FAILED: 'dispatch.fanout_failed',
	DISPATCH_INFRA_FAILURE: 'dispatch.infra_failure',
	DISPATCH_TALLY_THREW: 'dispatch.tally_threw',

	// Heal orchestration (claim/release of the 1-per-workflow slot + spawn).
	HEAL_CLAIMED: 'heal.claimed',
	HEAL_SKIPPED: 'heal.skipped',
	HEAL_SPAWNED: 'heal.spawned',
	HEAL_SPAWN_FAILED: 'heal.spawn_failed',
	HEAL_RECLAIMED_STALE: 'heal.reclaimed_stale',
	HEAL_SLOT_RELEASED: 'heal.slot_released',
	HEAL_SLOT_RELEASE_FAILED: 'heal.slot_release_failed',

	// Post-heal test sweep (per-event step.do loop in heal-flow.ts).
	HEAL_SWEEP_START: 'heal.sweep.start',
	HEAL_SWEEP_EVENT_START: 'heal.sweep.event_start',
	HEAL_SWEEP_EVENT_DONE: 'heal.sweep.event_done',
	HEAL_SWEEP_EVENT_EXHAUSTED: 'heal.sweep.event_exhausted',
	HEAL_SWEEP_EVENT_COUNT_NEAR_CAP: 'heal.sweep.event_count_near_cap',
	HEAL_SWEEP_END: 'heal.sweep.end',

	// Ephemeral test-runner primitive (upload + invoke + delete).
	TEST_RUNNER_UPLOAD_START: 'test_runner.upload_start',
	TEST_RUNNER_UPLOAD_DONE: 'test_runner.upload_done',
	TEST_RUNNER_INVOKE_START: 'test_runner.invoke_start',
	TEST_RUNNER_INVOKE_DONE: 'test_runner.invoke_done',
	TEST_RUNNER_DELETE_START: 'test_runner.delete_start',
	TEST_RUNNER_DELETE_DONE: 'test_runner.delete_done',

	// Agent-harness submit_candidate_source loop (heal role).
	HEAL_SUBMIT_STARTED: 'heal.submit.started',
	HEAL_SUBMIT_EVENT_PASSED: 'heal.submit.event_passed',
	HEAL_SUBMIT_EVENT_FAILED: 'heal.submit.event_failed',
	HEAL_SUBMIT_CONVERGED: 'heal.submit.converged',

	// Inside a Workflow entrypoint.
	WORKFLOW_RUN_START: 'workflow.run.start',
	WORKFLOW_RUN_END: 'workflow.run.end',
	WORKFLOW_RUN_FAILED: 'workflow.run.failed',
	WORKFLOW_STEP_WARNING: 'workflow.step.warning',

	// Cron dispatcher.
	CRON_TICK_END: 'cron.tick.end',
	CRON_TICK_FAILED: 'cron.tick.failed',

	// Webhook ingest / auth / teardown noise that ships through the same logger.
	WEBHOOK_INGESTED: 'webhook.ingested',
	AUTH_MAGIC_LINK_SENT: 'auth.magic_link.sent',
	AUTH_EMAIL_SEND_FAILED: 'auth.email.send_failed',
	TEARDOWN_WFP_DELETE_FAILED: 'teardown.wfp_delete_failed',
	TEST_RUNNER_CLEANUP_FAILED: 'test_runner.cleanup_failed'
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
