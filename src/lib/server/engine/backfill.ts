import { getDb } from '$lib/server/db';
import {
	countUnrunEventsForWorkflow,
	listUnrunEventsForWorkflow
} from '$lib/server/db/queries/events';
import { getWorkflowStatus } from '$lib/server/db/queries/workflows';
import { createLogger } from '$lib/server/log';
import { withLogContext } from '$lib/server/log-context';
import { EVENTS } from '$lib/server/log-events';
import { errorMessage } from '$lib/server/util';
import { executeExistingEventForWorkflow } from './executor';

const log = createLogger('backfill');

export type BackfillStopReason = 'completed' | 'paused' | 'error';

export interface BackfillResult {
	workflowId: string;
	processed: number;
	stoppedReason: BackfillStopReason;
	stoppedAt?: string;
}

// How many unrun events to fetch per iteration. Re-queried each pass so
// late-arriving events (webhooks landing while backfill runs) are picked up
// naturally — the workflow is `active` during backfill, so new events get a
// run inserted immediately via the normal executor path and won't appear in
// this query again.
const PAGE_SIZE = 100;

// Per-Worker-instance single-flight map. Matches the precedent set by the
// executor's `chains` map: cheap, explicit, but tied to one isolate — a
// cold-start or worker eviction will "forget" the lock, which is acceptable
// because (a) `resumeWorkflow` is human-initiated and infrequent, and (b) if
// a backfill dies mid-loop the user can simply re-resume to continue from
// where it left off (unrun events remain unrun). The alternative — a
// Cloudflare Workflow binding keyed by workflow id — would give durability
// across isolates but adds config surface area and an extra deploy step; we
// chose the simpler mechanism here and will upgrade later if needed.
const inFlight = new Map<string, Promise<BackfillResult>>();

export interface StartBackfillResult {
	started: boolean; // false if another backfill was already in flight
	expectedEventCount: number;
}

// Non-blocking launcher. Kicks off `runBackfillLoop` under the single-flight
// guard and returns the expected event count so callers can respond to the
// UI quickly. The actual loop runs detached — the caller is expected to keep
// the Worker alive via `ctx.waitUntil(whenDone)`.
export async function startBackfill(
	env: Env,
	workflowId: string
): Promise<StartBackfillResult & { whenDone: Promise<BackfillResult> }> {
	const db = getDb(env);
	const expectedEventCount = await countUnrunEventsForWorkflow(db, workflowId);

	const existing = inFlight.get(workflowId);
	if (existing) {
		// A backfill is already running for this workflow in this isolate.
		// No-op: the existing loop will continue processing events (and
		// naturally pick up any deferred-during-pause events), which is the
		// caller's intent.
		return { started: false, expectedEventCount, whenDone: existing };
	}

	const promise = runBackfillLoop(env, workflowId).finally(() => {
		inFlight.delete(workflowId);
	});
	inFlight.set(workflowId, promise);

	// Swallow rejections on the tracked promise so an uncaught error inside
	// the loop doesn't surface as an unhandled rejection — callers read the
	// result via `whenDone`, which re-exposes the rejection.
	promise.catch(() => {});

	return { started: true, expectedEventCount, whenDone: promise };
}

// Sequential FIFO executor over unrun events. Re-checks workflow status
// between events so a re-pause mid-backfill halts cleanly. A single event
// failing does NOT break the loop — it goes through the normal run-failed
// path (which can trigger heal, since the workflow is `active` during
// backfill). An uncaught error in the loop itself (distinct from a single
// event failing) aborts with `stoppedReason: 'error'` and rethrows.
export async function runBackfillLoop(env: Env, workflowId: string): Promise<BackfillResult> {
	return withLogContext({ context: 'backfill', workflow_id: workflowId }, async () => {
		const db = getDb(env);
		const expected = await countUnrunEventsForWorkflow(db, workflowId);

		log.info(EVENTS.WORKFLOW_BACKFILL_STARTED, {
			workflow_id: workflowId,
			expected_event_count: expected
		});

		let processed = 0;
		let stoppedReason: BackfillStopReason = 'completed';
		let stoppedAt: string | undefined;

		try {
			// Outer loop: re-query each iteration so concurrent inserts are
			// picked up and the "no rows left" termination is authoritative.
			while (true) {
				const status = await getWorkflowStatus(db, workflowId);
				if (status !== 'active') {
					stoppedReason = 'paused';
					break;
				}

				const batch = await listUnrunEventsForWorkflow(db, workflowId, PAGE_SIZE);
				if (batch.length === 0) {
					break;
				}

				for (const event of batch) {
					// Per-iteration pause re-check. If the user pauses mid-batch
					// we halt before starting the next run. The current event's
					// run (if already in flight) completes normally — the
					// executor's own pause check handles the race.
					const iterStatus = await getWorkflowStatus(db, workflowId);
					if (iterStatus !== 'active') {
						stoppedReason = 'paused';
						stoppedAt = event.id;
						break;
					}

					stoppedAt = event.id;
					try {
						// Dispatch via the existing executor path. `isReplay:
						// true` is the same flag used by heal-flow's sweep and
						// resumeNeedsAttention's replay — it marks the run row
						// so the UI can distinguish re-runs from original
						// dispatches, which is exactly the behavior we want
						// for a backfilled historical event. No backfill-
						// specific semantics needed.
						await executeExistingEventForWorkflow(env, event.id, workflowId, {
							isReplay: true
						});
						processed += 1;
					} catch (err) {
						// A single event failing at the executor boundary
						// (e.g. no current version, event row gone) does not
						// break the loop — log and continue. Run-level
						// failures (user_code/infra errors) are handled
						// inside the executor and return normally, so they
						// won't reach this catch; this is purely for the
						// "throw before a run row was created" surface.
						log.warn(EVENTS.WORKFLOW_BACKFILL_PROGRESS, {
							workflow_id: workflowId,
							event_id: event.id,
							processed,
							error: errorMessage(err),
							status: 'dispatch_threw'
						});
						// Count it as processed-attempted so the loop makes
						// forward progress; otherwise we'd retry the same
						// event forever.
						processed += 1;
						continue;
					}

					log.info(EVENTS.WORKFLOW_BACKFILL_PROGRESS, {
						workflow_id: workflowId,
						event_id: event.id,
						processed
					});
				}

				if (stoppedReason === 'paused') {
					break;
				}
				// Loop back and re-query. If the batch was smaller than
				// PAGE_SIZE the next query will return 0 rows and we exit via
				// the batch.length check.
			}
		} catch (err) {
			log.error(EVENTS.WORKFLOW_BACKFILL_STOPPED, {
				workflow_id: workflowId,
				processed,
				reason: 'error',
				error: errorMessage(err)
			});
			throw err;
		}

		const result: BackfillResult = {
			processed,
			stoppedReason,
			workflowId,
			...(stoppedAt !== undefined ? { stoppedAt } : {})
		};

		if (stoppedReason === 'paused') {
			log.info(EVENTS.WORKFLOW_BACKFILL_STOPPED, {
				workflow_id: workflowId,
				processed,
				reason: 'paused'
			});
		} else {
			log.info(EVENTS.WORKFLOW_BACKFILL_COMPLETED, {
				workflow_id: workflowId,
				processed
			});
		}

		return result;
	});
}
