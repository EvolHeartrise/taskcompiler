import { getDb } from '$lib/server/db';
import { createEvent, getEvent } from '$lib/server/db/queries/events';
import {
	finishHealSession,
	getActiveHealSession,
	getOpenNeedsAttentionSession,
	tryClaimHealSession
} from '$lib/server/db/queries/heal-sessions';
import { createRun, finishRunFailed, finishRunOk } from '$lib/server/db/queries/runs';
import { getCurrentVersion } from '$lib/server/db/queries/versions';
import {
	getWorkflow,
	getWorkflowStatus,
	listWorkflowsForEventSource
} from '$lib/server/db/queries/workflows';
import type { EventTriggerType, RunError, RunStatus } from '$lib/server/db/types';
import { createLogger } from '$lib/server/log';
import { withLogContext } from '$lib/server/log-context';
import { EVENTS } from '$lib/server/log-events';
import { errorMessage } from '$lib/server/util';
import { type DispatchEvent, type InvokeOutcome, invokeDispatcher } from './dispatch';

const log = createLogger('executor');

export interface ExecuteSourceEventOptions {
	eventSourceId: string;
	trigger: EventTriggerType;
	payload: unknown;
	headers?: Record<string, string>;
	dedupKey?: string;
}

export interface ExecuteManualOptions {
	workflowId: string;
	payload: unknown;
	dedupKey?: string;
}

export interface WorkflowDispatchResult {
	workflowId: string;
	runId: string | null;
	status: RunStatus;
	result?: unknown;
	error?: RunError;
	skipped?: 'no_current_version' | 'paused';
}

export interface ExecuteSourceEventResult {
	eventId: string;
	eventSourceId: string;
	dispatched: WorkflowDispatchResult[];
}

export interface ExecuteResult {
	eventId: string;
	runId: string | null;
	status: RunStatus;
	result?: unknown;
	error?: RunError;
	skipped?: 'paused';
}

export interface ExecuteExistingForWorkflowOptions {
	isReplay?: boolean;
	parentRunId?: string;
}

const DISPATCH_MAX_ATTEMPTS = 4;
const DISPATCH_BASE_DELAY_MS = 200;

// A heal_session row is considered stale (and recoverable) if it has been
// `running` for longer than this. The longest legitimate heal pipeline is
// agent (15m) + sweep (10m) + deploy (5m) ≈ 30m of step time, plus retries
// and queue scheduling. STALE_HEAL_AGE_MS sits well above that, so a stale
// row almost certainly means the workflow died without finalizing.
const STALE_HEAL_AGE_MS = 60 * 60 * 1000;

const chains = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = chains.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	chains.set(
		key,
		next.catch(() => {})
	);
	return next;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

type AttemptResult<T> = { done: true; value: T } | { done: false; reason: string; value?: T };

async function retryWithBackoff<T>(
	label: string,
	maxAttempts: number,
	baseDelayMs: number,
	attempt: () => Promise<AttemptResult<T>>
): Promise<AttemptResult<T>> {
	let last: AttemptResult<T> = { done: false, reason: 'no attempts ran' };
	for (let i = 0; i < maxAttempts; i++) {
		last = await attempt();
		if (last.done) {
			return last;
		}
		if (i < maxAttempts - 1) {
			const delay = baseDelayMs * 3 ** i;
			log.warn(EVENTS.DISPATCH_RETRY, {
				label,
				attempt: i + 1,
				max_attempts: maxAttempts,
				delay_ms: delay,
				reason: last.reason
			});
			await sleep(delay);
		}
	}
	return last;
}

// Try once, then on conflict force-recover any stale running row and try
// again. The stale path covers the worst-case "workflow died before any JS
// ran" — the in-process try/catch in heal-flow handles every other path.
async function claimHealSlotWithStaleRecovery(
	db: D1Database,
	input: { workflowId: string; triggeringRunId: string }
) {
	const first = await tryClaimHealSession(db, input);
	if (first) {
		return first;
	}
	const existing = await getActiveHealSession(db, input.workflowId);
	if (!existing) {
		// Lost the race to another claim that hasn't been observed yet — the
		// other heal is in-flight, so don't claim.
		return null;
	}
	const age = Date.now() - existing.startedAt;
	if (age < STALE_HEAL_AGE_MS) {
		return null;
	}
	log.warn(EVENTS.HEAL_RECLAIMED_STALE, {
		heal_session_id: existing.id,
		workflow_id: input.workflowId,
		age_sec: Math.round(age / 1000)
	});
	await releaseHealClaim(
		db,
		existing.id,
		`stale: no terminal status after ${Math.round(age / 60000)} minutes`
	);
	return tryClaimHealSession(db, input);
}

async function releaseHealClaim(
	db: D1Database,
	healSessionId: string,
	reason: string
): Promise<void> {
	try {
		await finishHealSession(db, healSessionId, {
			agentTranscript: null,
			diff: null,
			newVersionId: null,
			status: 'failed',
			testResults: null,
			unhealableReason: `release: ${reason}`
		});
	} catch (releaseError) {
		log.error(EVENTS.HEAL_SLOT_RELEASE_FAILED, {
			heal_session_id: healSessionId,
			release_error: errorMessage(releaseError)
		});
	}
}

async function dispatchWithRetry(
	env: Env,
	args: {
		scriptName: string;
		event: DispatchEvent;
		workflow: { id: string; name: string };
	}
): Promise<InvokeOutcome> {
	const result = await retryWithBackoff<InvokeOutcome>(
		'dispatch',
		DISPATCH_MAX_ATTEMPTS,
		DISPATCH_BASE_DELAY_MS,
		async () => {
			const outcome = await invokeDispatcher(env, args);
			if (outcome.kind !== 'infra_error') {
				return { done: true, value: outcome };
			}
			return { done: false, reason: outcome.error.message, value: outcome };
		}
	);
	return result.done ? result.value : result.value!;
}

// Workflows without a current version are skipped, but the event is still
// persisted so it can be replayed or backfilled once they come online.
export async function executeSourceEvent(
	env: Env,
	opts: ExecuteSourceEventOptions
): Promise<ExecuteSourceEventResult> {
	const db = getDb(env);
	const event = await createEvent(db, {
		dedupKey: opts.dedupKey ?? null,
		eventSourceId: opts.eventSourceId,
		headers: opts.headers,
		payload: opts.payload,
		triggerType: opts.trigger
	});

	const workflows = await listWorkflowsForEventSource(db, opts.eventSourceId);
	const dispatched: WorkflowDispatchResult[] = [];

	for (const workflow of workflows) {
		if (workflow.status === 'paused') {
			// Event row is already persisted above; skipping the run insert
			// keeps the "event without a run = needs backfill" invariant that
			// resumeWorkflow's backfill relies on (task 14).
			log.info(EVENTS.WORKFLOW_EVENT_DEFERRED, {
				workflow_id: workflow.id,
				event_id: event.id
			});
			dispatched.push({
				runId: null,
				skipped: 'paused',
				status: 'running',
				workflowId: workflow.id
			});
			continue;
		}
		if (!workflow.currentVersionId) {
			dispatched.push({
				runId: null,
				skipped: 'no_current_version',
				status: 'running',
				workflowId: workflow.id
			});
			continue;
		}
		try {
			const exec = await executeExistingEventForWorkflow(env, event.id, workflow.id);
			if (exec.skipped === 'paused') {
				dispatched.push({
					runId: null,
					skipped: 'paused',
					status: 'running',
					workflowId: workflow.id
				});
				continue;
			}
			dispatched.push({
				error: exec.error,
				result: exec.result,
				runId: exec.runId,
				status: exec.status,
				workflowId: workflow.id
			});
		} catch (error) {
			const msg = errorMessage(error);
			log.error(EVENTS.DISPATCH_FANOUT_FAILED, {
				workflow_id: workflow.id,
				error: msg
			});
			dispatched.push({
				error: { category: 'infra', message: msg, name: 'DispatchThrew' },
				runId: null,
				status: 'failed',
				workflowId: workflow.id
			});
		}
	}

	return {
		dispatched,
		eventId: event.id,
		eventSourceId: opts.eventSourceId
	};
}

export class WorkflowPausedError extends Error {
	constructor(workflowId: string) {
		super(`Workflow is paused: ${workflowId}`);
		this.name = 'WorkflowPausedError';
	}
}

export async function executeManualEvent(
	env: Env,
	opts: ExecuteManualOptions
): Promise<ExecuteResult> {
	const db = getDb(env);
	const workflow = await getWorkflow(db, opts.workflowId);
	if (!workflow) {
		throw new Error(`Workflow not found: ${opts.workflowId}`);
	}
	if (workflow.status === 'paused') {
		throw new WorkflowPausedError(workflow.id);
	}
	if (!workflow.currentVersionId) {
		throw new Error(`Workflow has no current version: ${opts.workflowId}`);
	}

	const event = await createEvent(db, {
		dedupKey: opts.dedupKey ?? null,
		eventSourceId: workflow.eventSourceId,
		payload: opts.payload,
		triggerType: 'manual'
	});

	return executeExistingEventForWorkflow(env, event.id, workflow.id);
}

export async function executeExistingEventForWorkflow(
	env: Env,
	eventId: string,
	workflowId: string,
	opts: ExecuteExistingForWorkflowOptions = {}
): Promise<ExecuteResult> {
	const db = getDb(env);
	const event = await getEvent(db, eventId);
	if (!event) {
		throw new Error(`Event not found: ${eventId}`);
	}

	const workflow = await getWorkflow(db, workflowId);
	if (!workflow) {
		throw new Error(`Workflow not found: ${workflowId}`);
	}

	const version = await getCurrentVersion(db, workflow.id);
	if (!version) {
		throw new Error(`Workflow has no current version: ${workflow.id}`);
	}

	return withLock(workflow.id, async () => {
		// Last-chance pause re-read inside the per-workflow lock, so a pause
		// that lands between the initial load and this point still wins the
		// race. The event row stays put; backfill (task 14) picks it up on
		// resume via "events with no run".
		const freshStatus = await getWorkflowStatus(db, workflow.id);
		if (freshStatus === 'paused') {
			log.info(EVENTS.WORKFLOW_EVENT_DEFERRED, {
				workflow_id: workflow.id,
				event_id: event.id
			});
			return {
				eventId: event.id,
				runId: null,
				skipped: 'paused' as const,
				status: 'running' as const
			};
		}

		const run = await createRun(db, {
			eventId: event.id,
			isReplay: opts.isReplay ?? false,
			parentRunId: opts.parentRunId ?? null,
			versionId: version.id,
			workflowId: workflow.id
		});

		return withLogContext(
			{
				run_id: run.id,
				workflow_id: workflow.id,
				event_id: event.id,
				version_id: version.id,
				trigger: event.triggerType
			},
			async (): Promise<ExecuteResult> => {
				log.info(EVENTS.RUN_STARTED, { is_replay: opts.isReplay === true });

				const outcome = await dispatchWithRetry(env, {
					event: {
						headers: event.headers,
						id: event.id,
						payload: event.payload,
						receivedAt: event.receivedAt,
						triggerType: event.triggerType
					},
					scriptName: version.deployPath,
					workflow: { id: workflow.id, name: workflow.name }
				});

				if (outcome.kind === 'ok') {
					await finishRunOk(db, run.id, outcome.result, outcome.logs);
					log.info(EVENTS.RUN_COMPLETED);
					return {
						eventId: event.id,
						result: outcome.result,
						runId: run.id,
						status: 'ok' as const
					};
				}

				// Both user_error and infra_error persist as failed runs (distinguished
				// by error.category); only user_error spawns a heal below.
				const runError = outcome.error;
				const runLogs = outcome.kind === 'user_error' ? outcome.logs : [];
				await finishRunFailed(db, run.id, runError, runLogs);
				log.warn(EVENTS.RUN_FAILED, {
					category: runError.category,
					error_name: runError.name,
					error_message: runError.message
				});

				if (outcome.kind === 'infra_error') {
					log.error(EVENTS.DISPATCH_INFRA_FAILURE, {
						error_name: runError.name,
						error_message: runError.message
					});
					return {
						error: runError,
						eventId: event.id,
						runId: run.id,
						status: 'failed' as const
					};
				}

				const needsAttention = await getOpenNeedsAttentionSession(db, workflow.id);
				if (needsAttention) {
					log.info(EVENTS.HEAL_SKIPPED, {
						reason: 'unresolved needs_attention session',
						blocking_session_id: needsAttention.id
					});
					return {
						error: runError,
						eventId: event.id,
						runId: run.id,
						status: 'failed' as const
					};
				}
				// A pause landed while this run was in-flight: don't open a new
				// heal session. An already-running heal (claimed before the
				// pause) is allowed to finish — the deploy step inside it also
				// re-checks pause state before touching the current version.
				const pausedNow = await getWorkflowStatus(db, workflow.id);
				if (pausedNow === 'paused') {
					log.info(EVENTS.WORKFLOW_HEAL_SKIPPED_PAUSED, {
						workflow_id: workflow.id,
						triggering_run_id: run.id
					});
					return {
						error: runError,
						eventId: event.id,
						runId: run.id,
						status: 'failed' as const
					};
				}
				// Strict dedup: claim the heal slot via an atomic INSERT against the
				// partial unique index `idx_heal_sessions_one_running_per_workflow`
				// (status='running'). If another failure raced us to the slot, the
				// INSERT returns null and we skip spawning. The slot is freed when
				// the heal finalizes the row to a terminal status (heal-flow's
				// catch-all also finalizes on unexpected failure, so a dead heal
				// can't permanently block future ones).
				const claimed = await claimHealSlotWithStaleRecovery(db, {
					triggeringRunId: run.id,
					workflowId: workflow.id
				});
				if (!claimed) {
					log.info(EVENTS.HEAL_SKIPPED, { reason: 'slot already claimed' });
				} else {
					log.info(EVENTS.HEAL_CLAIMED, { heal_session_id: claimed.id });
					try {
						await env.HEAL_WORKFLOW.create({
							id: `heal-${claimed.id}`,
							params: {
								healSessionId: claimed.id,
								triggeringRunId: run.id,
								workflowId: workflow.id
							}
						});
						log.info(EVENTS.HEAL_SPAWNED, { heal_session_id: claimed.id });
					} catch (error) {
						log.error(EVENTS.HEAL_SPAWN_FAILED, {
							heal_session_id: claimed.id,
							error: errorMessage(error)
						});
						// Release the claimed slot so future failures can heal.
						await releaseHealClaim(db, claimed.id, errorMessage(error));
					}
				}
				return {
					error: runError,
					eventId: event.id,
					runId: run.id,
					status: 'failed' as const
				};
			}
		);
	});
}
