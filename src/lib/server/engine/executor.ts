import { createEvent, getEvent } from '$lib/server/db/queries/events';
import {
	getActiveHealSession,
	getOpenNeedsAttentionSession
} from '$lib/server/db/queries/heal-sessions';
import { createRun, finishRunFailed, finishRunOk } from '$lib/server/db/queries/runs';
import { getCurrentVersion } from '$lib/server/db/queries/versions';
import { getWorkflow, listWorkflowsForEventSource } from '$lib/server/db/queries/workflows';
import type { EventTriggerType, RunError, RunLogEntry, RunStatus } from '$lib/server/db/types';
import { getEnv } from '$lib/server/env';
import { classifyInfraFailure } from './run-error';

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
	runId: string;
	status: RunStatus;
	result?: unknown;
	error?: RunError;
	skipped?: 'no_current_version';
}

export interface ExecuteSourceEventResult {
	eventId: string;
	eventSourceId: string;
	dispatched: WorkflowDispatchResult[];
}

export interface ExecuteResult {
	eventId: string;
	runId: string;
	status: RunStatus;
	result?: unknown;
	error?: RunError;
}

export interface ExecuteExistingForWorkflowOptions {
	isReplay?: boolean;
	parentRunId?: string;
}

interface InvokeResponseBody {
	ok: boolean;
	result?: unknown;
	error?: RunError;
	logs?: RunLogEntry[];
}

type DispatchOutcome =
	| { kind: 'ok'; result: unknown; logs: RunLogEntry[] }
	| { kind: 'user_error'; error: RunError; logs: RunLogEntry[] }
	| { kind: 'infra_error'; error: RunError };

const DISPATCH_MAX_ATTEMPTS = 4;
const DISPATCH_BASE_DELAY_MS = 200;

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

// Generic exponential backoff (3^i). `attempt` returns done:true to stop or
// done:false to retry. After maxAttempts, returns the last attempt's result.
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
			console.warn(
				`[executor] ${label} attempt ${i + 1}/${maxAttempts} failed, retrying in ${delay}ms`,
				{ reason: last.reason }
			);
			await sleep(delay);
		}
	}
	return last;
}

async function dispatchOnce(args: {
	deployPath: string;
	workflowId: string;
	workflowName: string;
	event: {
		id: string;
		triggerType: EventTriggerType;
		receivedAt: number;
		payload: unknown;
		headers: Record<string, string>;
	};
}): Promise<DispatchOutcome> {
	const env = getEnv();
	try {
		const response = await env.DISPATCHER.get(args.deployPath).fetch('https://workflow.invoke/', {
			body: JSON.stringify({
				event: args.event,
				workflow: { id: args.workflowId, name: args.workflowName }
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
		if (!response.ok) {
			return {
				error: classifyInfraFailure(
					'DispatchHttpError',
					`dispatcher returned HTTP ${response.status}`
				),
				kind: 'infra_error'
			};
		}
		let body: InvokeResponseBody;
		try {
			body = (await response.json()) as InvokeResponseBody;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				error: classifyInfraFailure('InvalidDispatchBody', `dispatcher body parse failed: ${msg}`),
				kind: 'infra_error'
			};
		}
		const logs = body.logs ?? [];
		if (body.ok) {
			return { kind: 'ok', logs, result: body.result };
		}
		const rawErr = body.error ?? {
			message: 'workflow reported failure with no error',
			name: 'Error'
		};
		return {
			error: { ...rawErr, category: 'user_code' },
			kind: 'user_error',
			logs
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return {
			error: classifyInfraFailure('DispatchNetworkError', `dispatcher fetch threw: ${msg}`),
			kind: 'infra_error'
		};
	}
}

async function dispatchWithRetry(args: {
	deployPath: string;
	workflowId: string;
	workflowName: string;
	event: {
		id: string;
		triggerType: EventTriggerType;
		receivedAt: number;
		payload: unknown;
		headers: Record<string, string>;
	};
}): Promise<DispatchOutcome> {
	const result = await retryWithBackoff<DispatchOutcome>(
		'dispatch',
		DISPATCH_MAX_ATTEMPTS,
		DISPATCH_BASE_DELAY_MS,
		async () => {
			const outcome = await dispatchOnce(args);
			if (outcome.kind !== 'infra_error') {
				return { done: true, value: outcome };
			}
			return { done: false, reason: outcome.error.message, value: outcome };
		}
	);
	return result.done ? result.value : result.value!;
}

// Capture an event on an event source and fan out to every workflow attached
// To the source. Each workflow that has a current version gets its own run;
// Workflows still generating (no currentVersionId) are skipped — the event
// Is persisted and can be replayed (or backfilled) once they come online.
export async function executeSourceEvent(
	opts: ExecuteSourceEventOptions
): Promise<ExecuteSourceEventResult> {
	const event = await createEvent({
		dedupKey: opts.dedupKey ?? null,
		eventSourceId: opts.eventSourceId,
		headers: opts.headers,
		payload: opts.payload,
		triggerType: opts.trigger
	});

	const workflows = await listWorkflowsForEventSource(opts.eventSourceId);
	const dispatched: WorkflowDispatchResult[] = [];

	for (const workflow of workflows) {
		if (!workflow.currentVersionId) {
			dispatched.push({
				runId: '',
				skipped: 'no_current_version',
				status: 'running',
				workflowId: workflow.id
			});
			continue;
		}
		try {
			const exec = await executeExistingEventForWorkflow(event.id, workflow.id);
			dispatched.push({
				error: exec.error,
				result: exec.result,
				runId: exec.runId,
				status: exec.status,
				workflowId: workflow.id
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[executor] fanout dispatch failed for workflow=${workflow.id}: ${msg}`);
			dispatched.push({
				error: { category: 'infra', message: msg, name: 'DispatchThrew' },
				runId: '',
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

// Manual trigger from a workflow page — creates a manual event under the
// Workflow's event source and dispatches to that single workflow only.
export async function executeManualEvent(opts: ExecuteManualOptions): Promise<ExecuteResult> {
	const workflow = await getWorkflow(opts.workflowId);
	if (!workflow) {
		throw new Error(`Workflow not found: ${opts.workflowId}`);
	}
	if (!workflow.currentVersionId) {
		throw new Error(`Workflow has no current version: ${opts.workflowId}`);
	}

	const event = await createEvent({
		dedupKey: opts.dedupKey ?? null,
		eventSourceId: workflow.eventSourceId,
		payload: opts.payload,
		triggerType: 'manual'
	});

	return executeExistingEventForWorkflow(event.id, workflow.id);
}

export async function executeExistingEventForWorkflow(
	eventId: string,
	workflowId: string,
	opts: ExecuteExistingForWorkflowOptions = {}
): Promise<ExecuteResult> {
	const event = await getEvent(eventId);
	if (!event) {
		throw new Error(`Event not found: ${eventId}`);
	}

	const workflow = await getWorkflow(workflowId);
	if (!workflow) {
		throw new Error(`Workflow not found: ${workflowId}`);
	}

	const version = await getCurrentVersion(workflow.id);
	if (!version) {
		throw new Error(`Workflow has no current version: ${workflow.id}`);
	}

	return withLock(workflow.id, async () => {
		const run = await createRun({
			eventId: event.id,
			isReplay: opts.isReplay ?? false,
			parentRunId: opts.parentRunId ?? null,
			versionId: version.id,
			workflowId: workflow.id
		});

		const outcome = await dispatchWithRetry({
			deployPath: version.deployPath,
			event: {
				headers: event.headers,
				id: event.id,
				payload: event.payload,
				receivedAt: event.receivedAt,
				triggerType: event.triggerType
			},
			workflowId: workflow.id,
			workflowName: workflow.name
		});

		if (outcome.kind === 'ok') {
			await finishRunOk(run.id, outcome.result, outcome.logs);
			return {
				eventId: event.id,
				result: outcome.result,
				runId: run.id,
				status: 'ok' as const
			};
		}

		// Both user_error and infra_error are persisted as failed runs. The
		// Error.category on the row distinguishes them; only user_code
		// Failures spawn a heal below.
		const runError = outcome.error;
		const runLogs = outcome.kind === 'user_error' ? outcome.logs : [];
		await finishRunFailed(run.id, runError, runLogs);

		if (outcome.kind === 'infra_error') {
			console.error(
				`[executor] infra failure after retries for runId=${run.id}: ${runError.name}: ${runError.message}`
			);
			return {
				error: runError,
				eventId: event.id,
				runId: run.id,
				status: 'failed' as const
			};
		}

		// User-code failure. Suppress heal if the workflow already has an
		// Unresolved needs_attention session, or a running heal session.
		const needsAttention = await getOpenNeedsAttentionSession(workflow.id);
		if (needsAttention) {
			console.log(
				`[heal] skipping create for runId=${run.id}: workflow has unresolved needs_attention session (sessionId=${needsAttention.id})`
			);
			return {
				error: runError,
				eventId: event.id,
				runId: run.id,
				status: 'failed' as const
			};
		}
		// Dedup: at most one in-flight heal per workflow. Small race window
		// (two simultaneous failures can both spawn) bounds waste to ~2×.
		// Missed failures are replayed by the winning heal's post-deploy sweep.
		const activeHeal = await getActiveHealSession(workflow.id);
		if (activeHeal) {
			console.log(
				`[heal] skipping create for runId=${run.id}: active session already running (sessionId=${activeHeal.id})`
			);
		} else {
			try {
				const env = getEnv();
				await env.HEAL_WORKFLOW.create({
					id: `heal-${run.id}`,
					params: {
						triggeringRunId: run.id,
						workflowId: workflow.id
					}
				});
			} catch (error) {
				console.error(`failed to start HEAL_WORKFLOW for runId=${run.id}`, error);
			}
		}
		return {
			error: runError,
			eventId: event.id,
			runId: run.id,
			status: 'failed' as const
		};
	});
}
