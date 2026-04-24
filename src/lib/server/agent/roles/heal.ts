import { type AgentEvent, type AgentRunResult, DEFAULT_MODEL, runAgent } from '../loop.ts';
import type { Tool } from '../tools.ts';
import { defineTool } from '../tool-schema.ts';
import { getDb } from '$lib/server/db';
import { getWorkflow } from '$lib/server/db/queries/workflows';
import { getCurrentVersion } from '$lib/server/db/queries/versions';
import { getEvent, listAllEventsForWorkflow } from '$lib/server/db/queries/events';
import { getRun, listFailedRunsForWorkflow } from '$lib/server/db/queries/runs';
import { listSecretNamesForProject } from '$lib/server/db/queries/secrets';
import { runAgainstEventEphemeral } from '$lib/server/engine/test-runner';
import { EmitSuccess, makeTypecheckedEmitTool, wrapTerminal } from './shared.ts';
import { buildTriageBlock } from '$lib/server/healer/triage';
import type { Event, RunError, RunLogEntry, UnhealableCategory } from '$lib/server/db/types';
import { errorMessage, truncate } from '$lib/server/util';

export interface HealOptions {
	env: Env;
	workflowId: string;
	triggeringRunId: string;
	model?: string;
	onEvent?: (e: AgentEvent) => void;
	maxTurns?: number;
	maxTokens?: number;
}

// Heal runs include the full candidate source in each emit_fixed_workflow
// call, so 4k tokens trips out on non-trivial workflows. Bumped only for
// heal — gen-flow generates from a blank slate and doesn't need the budget.
const HEAL_MAX_TOKENS = 8192;

export interface HealTestDetail {
	eventId: string;
	ok: boolean;
	error?: RunError;
}

export type HealOutcome =
	| {
			kind: 'fixed';
			sourceTs: string;
			summary: string;
			agentTranscript: AgentEvent[];
	  }
	| {
			kind: 'unhealable';
			category: UnhealableCategory;
			reason: string;
			agentTranscript: AgentEvent[];
	  }
	| {
			kind: 'failed' | 'abandoned';
			reason: string;
			agentTranscript: AgentEvent[];
	  };

interface EmittedFixPayload {
	kind: 'fixed';
	sourceTs: string;
	summary: string;
}

interface EmittedUnhealablePayload {
	kind: 'unhealable';
	category: UnhealableCategory;
	reason: string;
}

type EmittedPayload = EmittedFixPayload | EmittedUnhealablePayload;

// Agent-facing terminal-failure tool no longer asks the agent to classify.
// Downstream (UI, DB) still reads `unhealableCategory`; we default to 'other'
// and let `unhealableReason` carry the actual evidence.
const CANNOT_FIX_CATEGORY: UnhealableCategory = 'other';

export const HEAL_SYSTEM_PROMPT = `You are Runely's workflow healer. A user workflow just failed — your job is to diagnose the failure and either produce a corrected version or declare that no code change can fix it.

## Same contract as the gen role
The workflow module is a single TypeScript file exporting \`export default async function run(event: unknown, ctx: Ctx)\`. The ctx surface is fixed:
- ctx.workflow: { id, name }
- ctx.event: { id, triggerType, receivedAt }
- ctx.http.{fetch,get,post}  // post auto-JSON-encodes plain objects
- ctx.log(level, message, data?)
- ctx.state.get<T>(key) / ctx.state.set(key, value)
- ctx.secret(name) -> string (throws if unset)

No imports from node_modules, no relative imports. \`event\` is \`{ body, headers }\` at runtime — \`body\` is the parsed payload, \`headers\` is a lowercased Record<string, string> with auth/signature headers redacted to \`"<redacted>"\`. It's typed \`unknown\`, so validate the shape inside \`run\`.

## Your tools
- list_events / get_event: inspect historical events for this workflow
- list_failed_runs / get_run: inspect recent failures
- run_test_event: run a candidate source against a specific historical event in isolation (deploys and tears down a temp Worker per call). Each call costs a few seconds of upload latency, so don't burn budget testing trivial things — use it to validate your final candidate against the failing event and a couple of historical ones.
- emit_fixed_workflow: terminal. Call when a code change fixes the failure.
- emit_cannot_fix: terminal. Call when the failure is NOT fixable by changing workflow code (upstream outage, missing/expired secret, structurally alien input, or a capability gap in the ctx surface). The tool description has the full criteria.

## Principles
- Diagnose first. Read the error + stack + logs and inspect the failing event payload against the source. Form a hypothesis before editing.
- Change as little as possible. Do not rewrite the workflow. Patch the specific bug.
- The most common failure classes: unvalidated event shape, missing ctx.secret, bad HTTP status not checked, JSON parse on a non-JSON response, undefined path in event.
- After your fix, run_test_event on the failing event AND at least two historical events to confirm no regressions.
- Keep the run fail-fast semantics — don't swallow exceptions.

## Convergence
Call exactly ONE terminal tool: \`emit_fixed_workflow\` on success, or \`emit_cannot_fix\` if the failure is not code-fixable. Strongly prefer fixing — a wrong escalation costs the user more than a wrong fix. If you're not sure, attempt a fix. Do not emit partial or placeholder code.

## Typecheck gate on emit_fixed_workflow
The source you emit is type-checked against the Ctx interface. \`ctx.secret\` accepts only the project's current secret names (listed in the user message); a typo or unknown name is a TS error. If emit_fixed_workflow returns a tool error with TypeScript diagnostics, read them, fix the code, and call emit_fixed_workflow again.`;

function formatJson(value: unknown, opts: { pretty?: boolean; max?: number } = {}): string {
	const max = opts.max ?? 4000;
	let str: string;
	try {
		str = JSON.stringify(value, null, opts.pretty ? 2 : 0);
	} catch {
		str = String(value);
	}
	if (str === undefined) {
		str = 'undefined';
	}
	return truncate(str, max);
}

function buildUserMessage(args: {
	workflowName: string;
	workflowId: string;
	userPrompt: string;
	currentSource: string;
	triggeringError: RunError | null;
	triggeringLogs: RunLogEntry[] | null;
	failedEvent: Event | null;
	historicalEvents: readonly Event[];
	availableSecrets: string[];
}): string {
	const parts: string[] = [];
	parts.push(`Workflow: ${args.workflowName} (id=${args.workflowId})`);
	parts.push('');

	// Triage up top so the agent doesn't re-derive things we already know.
	parts.push(
		buildTriageBlock({
			currentSource: args.currentSource,
			failedEvent: args.failedEvent,
			historicalEvents: args.historicalEvents,
			triggeringError: args.triggeringError
		})
	);

	parts.push('## Original user prompt');
	parts.push(args.userPrompt || '(none)');
	parts.push('');
	parts.push('## Available secrets (via ctx.secret)');
	parts.push(
		args.availableSecrets.length === 0
			? '(none — if the failure is because a needed secret is missing, use emit_cannot_fix and describe which secret is missing in the reason)'
			: args.availableSecrets.map((n) => `- ${n}`).join('\n')
	);
	parts.push('');
	parts.push('## Current source');
	parts.push('```ts');
	parts.push(truncate(args.currentSource, 8000));
	parts.push('```');
	parts.push('');
	parts.push('## Triggering failed run — error');
	if (args.triggeringError) {
		parts.push(`error.name: ${args.triggeringError.name}`);
		parts.push(`error.message: ${args.triggeringError.message}`);
		if (args.triggeringError.stack) {
			parts.push('error.stack:');
			parts.push('```');
			parts.push(truncate(args.triggeringError.stack, 2000));
			parts.push('```');
		}
	} else {
		parts.push('(no error recorded)');
	}
	parts.push('');

	// Short log tail only — the triage block already classifies + surfaces
	// source context. Full logs are available via get_run when needed.
	const logTail = (args.triggeringLogs ?? []).slice(-8);
	if (logTail.length > 0) {
		parts.push('## Log tail from that run (last 8 entries)');
		parts.push('```json');
		parts.push(formatJson(logTail, { pretty: true, max: 1500 }));
		parts.push('```');
		parts.push('');
	}

	parts.push('## Failed event payload');
	if (args.failedEvent) {
		parts.push(
			`event.id=${args.failedEvent.id}, triggerType=${args.failedEvent.triggerType}, receivedAt=${args.failedEvent.receivedAt}`
		);
		parts.push('```json');
		parts.push(formatJson(args.failedEvent.payload, { pretty: true, max: 3000 }));
		parts.push('```');
	} else {
		parts.push('(event not found)');
	}
	parts.push('');
	parts.push(`## Historical events available: ${args.historicalEvents.length}`);
	parts.push('');
	parts.push(
		"Diagnose the root cause. The TRIAGE block above already classifies the error and shows source context for the failing line — don't re-derive those. Use `list_events`, `get_event`, `list_failed_runs`, `get_run`, `run_test_event` to explore; if you need multiple events, emit all `get_event` calls in one turn. When you have a fix, call `emit_fixed_workflow` ONCE with the complete new module source. Prefer minimal, surgical changes."
	);
	return parts.join('\n');
}

function makeListEventsTool(env: Env, workflowId: string): Tool {
	return defineTool<{ limit: number }>({
		name: 'list_events',
		description:
			'List historical events for this workflow in chronological (ascending) order. Returns id, receivedAt, triggerType and a short payload preview.',
		fields: {
			limit: {
				kind: 'number',
				description: 'Max number of events to return. Default 20.',
				default: 20
			}
		},
		async run({ limit }): Promise<string> {
			const all = await listAllEventsForWorkflow(getDb(env), workflowId);
			const slice = all.slice(-Math.max(1, Math.floor(limit)));
			const out = slice.map((e) => ({
				id: e.id,
				payloadPreview: formatJson(e.payload, { max: 200 }),
				receivedAt: e.receivedAt,
				triggerType: e.triggerType
			}));
			return JSON.stringify({ events: out, returned: out.length, total: all.length });
		}
	});
}

function makeGetEventTool(env: Env, workflowId: string, eventSourceId: string): Tool {
	return defineTool<{ id: string }>({
		name: 'get_event',
		description:
			"Fetch full details of a single event (including payload) by id. The event must belong to this workflow's event source.",
		fields: {
			id: { kind: 'string', description: 'Event id' }
		},
		required: ['id'],
		async run({ id }): Promise<string> {
			const event = await getEvent(getDb(env), id);
			if (!event) {
				throw new Error(`get_event: event not found: ${id}`);
			}
			if (event.eventSourceId !== eventSourceId) {
				throw new Error(
					`get_event: event does not belong to this workflow's event source (workflowId=${workflowId})`
				);
			}
			return JSON.stringify({
				id: event.id,
				payload: event.payload,
				receivedAt: event.receivedAt,
				triggerType: event.triggerType
			});
		}
	});
}

function makeListFailedRunsTool(env: Env, workflowId: string): Tool {
	return defineTool<{ limit: number }>({
		name: 'list_failed_runs',
		description:
			'List recent failed runs for this workflow. Returns runId, eventId, startedAt, and error summary.',
		fields: {
			limit: {
				kind: 'number',
				description: 'Max number of runs to return. Default 10.',
				default: 10
			}
		},
		async run({ limit }): Promise<string> {
			const all = await listFailedRunsForWorkflow(getDb(env), workflowId);
			const slice = all.slice(0, Math.max(1, Math.floor(limit)));
			const out = slice.map((r) => ({
				error: r.error,
				eventId: r.eventId,
				runId: r.id,
				startedAt: r.startedAt
			}));
			return JSON.stringify({ returned: out.length, runs: out, total: all.length });
		}
	});
}

function makeGetRunTool(env: Env, workflowId: string): Tool {
	return defineTool<{ runId: string }>({
		name: 'get_run',
		description: 'Fetch a full run including logs by id. The run must belong to this workflow.',
		fields: {
			runId: { kind: 'string', description: 'Run id' }
		},
		required: ['runId'],
		async run({ runId }): Promise<string> {
			const run = await getRun(getDb(env), runId);
			if (!run) {
				throw new Error(`get_run: run not found: ${runId}`);
			}
			if (run.workflowId !== workflowId) {
				throw new Error('get_run: run does not belong to this workflow');
			}
			return JSON.stringify({
				error: run.error,
				eventId: run.eventId,
				finishedAt: run.finishedAt,
				id: run.id,
				isReplay: run.isReplay,
				logs: run.logs ?? [],
				result: run.result,
				startedAt: run.startedAt,
				status: run.status,
				versionId: run.versionId
			});
		}
	});
}

function makeRunTestEventTool(env: Env, workflowId: string): Tool {
	return defineTool<{ event_id: string; source_ts: string }>({
		name: 'run_test_event',
		description:
			"Run a candidate TS source against a specific historical event in isolation. Each call deploys a temporary Worker, invokes it, and tears it down — costs a few seconds of upload latency. Don't burn budget testing trivial things; use it to validate your final candidate against the failing event and a couple of historical ones. Returns { ok, error?, logs_tail } (last 20 log entries).",
		fields: {
			event_id: { kind: 'string', description: 'Historical event id to test against' },
			source_ts: { kind: 'string', description: 'Candidate TypeScript workflow source to test' }
		},
		required: ['event_id', 'source_ts'],
		async run({ event_id, source_ts }): Promise<string> {
			const db = getDb(env);
			const event = await getEvent(db, event_id);
			if (!event) {
				throw new Error(`run_test_event: event not found: ${event_id}`);
			}
			const workflow = await getWorkflow(db, workflowId);
			if (!workflow) {
				throw new Error(`run_test_event: workflow not found: ${workflowId}`);
			}
			if (event.eventSourceId !== workflow.eventSourceId) {
				throw new Error("run_test_event: event does not belong to this workflow's event source");
			}
			const res = await runAgainstEventEphemeral(env, source_ts, event, workflow);
			const tail = res.logs.slice(-20);
			return JSON.stringify({
				durationMs: res.durationMs,
				error: res.error,
				logs_tail: tail,
				ok: res.ok
			});
		}
	});
}

function makeEmitCannotFixTool(state: { emitted: EmittedPayload | null }): Tool {
	return defineTool<{ reason: string }>({
		name: 'emit_cannot_fix',
		description:
			"Declare the failure is NOT fixable by changing workflow code. Call EXACTLY ONCE with an evidence-backed reason. Only use after diagnosing the triggering error and forming a concrete hypothesis about why no code change would help. Typical situations: (a) upstream API the workflow depends on is down or 5xx-ing — but only if a single fetch failure isn't a retry candidate; (b) a required secret (via ctx.secret) is missing, expired, or returns 401/403 with a clear auth-rejected message; (c) the incoming event is structurally unlike anything the workflow was built for and reshaping the workflow would change its intent; (d) the workflow is asked to do something the ctx surface can't support (no filesystem, no spawn, no specific binding). Prefer fixing if there's any doubt. `reason` must cite the specific error text, response body, or observed behaviour proving the cause is external.",
		fields: {
			reason: {
				kind: 'string',
				description:
					'Evidence-backed explanation: specific error text, observed behaviour, or response body that demonstrates the cause is external to the workflow code. 1–3 sentences.'
			}
		},
		required: ['reason'],
		async run({ reason }): Promise<string> {
			if (reason.trim().length === 0) {
				throw new Error('emit_cannot_fix: `reason` must be a non-empty string');
			}
			state.emitted = {
				category: CANNOT_FIX_CATEGORY,
				kind: 'unhealable',
				reason: reason.trim()
			};
			throw new EmitSuccess(state.emitted);
		}
	});
}

function formatTerminal(payload: EmittedPayload): string {
	if (payload.kind === 'fixed') {
		return `ok: fix received (${payload.summary})`;
	}
	return `ok: escalated as cannot_fix`;
}

export async function healWorkflow(opts: HealOptions): Promise<HealOutcome> {
	const db = getDb(opts.env);
	const workflow = await getWorkflow(db, opts.workflowId);
	if (!workflow) {
		return {
			agentTranscript: [],
			kind: 'failed',
			reason: `workflow not found: ${opts.workflowId}`
		};
	}

	const currentVersion = await getCurrentVersion(db, opts.workflowId);
	if (!currentVersion) {
		return {
			agentTranscript: [],
			kind: 'failed',
			reason: `workflow has no current version: ${opts.workflowId}`
		};
	}

	const currentSource = currentVersion.sourceTs;

	const triggeringRun = await getRun(db, opts.triggeringRunId);
	const failedEvent = triggeringRun ? await getEvent(db, triggeringRun.eventId) : null;
	const historicalEvents = await listAllEventsForWorkflow(db, opts.workflowId);
	const secretMetas = await listSecretNamesForProject(db, workflow.projectId);
	const secretNames = secretMetas.map((s) => s.name);

	const userMessage = buildUserMessage({
		availableSecrets: secretNames,
		currentSource,
		failedEvent,
		historicalEvents,
		triggeringError: triggeringRun?.error ?? null,
		triggeringLogs: triggeringRun?.logs ?? null,
		userPrompt: workflow.prompt,
		workflowId: workflow.id,
		workflowName: workflow.name
	});

	const emitState: { attempts: number; emitted: EmittedPayload | null } = {
		attempts: 0,
		emitted: null
	};
	const controller = new AbortController();

	const tools: Tool[] = [
		makeListEventsTool(opts.env, opts.workflowId),
		makeGetEventTool(opts.env, opts.workflowId, workflow.eventSourceId),
		makeListFailedRunsTool(opts.env, opts.workflowId),
		makeGetRunTool(opts.env, opts.workflowId),
		makeRunTestEventTool(opts.env, opts.workflowId),
		wrapTerminal<EmittedPayload>(
			makeTypecheckedEmitTool<EmittedPayload>({
				name: 'emit_fixed_workflow',
				description:
					'Deliver the corrected workflow. Call this EXACTLY ONCE with the full TypeScript module source and a short summary of the fix. This is the only way to finish the task for a code-fixable failure.',
				secretNames,
				maxAttempts: 2,
				state: emitState,
				buildPayload: ({ sourceTs, summary }) => ({ kind: 'fixed', sourceTs, summary })
			}),
			controller,
			formatTerminal
		),
		wrapTerminal<EmittedPayload>(makeEmitCannotFixTool(emitState), controller, formatTerminal)
	];

	let result: AgentRunResult;
	try {
		result = await runAgent({
			abortSignal: controller.signal,
			env: opts.env,
			maxTokens: opts.maxTokens ?? HEAL_MAX_TOKENS,
			maxTurns: opts.maxTurns ?? 50,
			model: opts.model ?? DEFAULT_MODEL,
			onEvent: opts.onEvent,
			systemPrompt: HEAL_SYSTEM_PROMPT,
			tools,
			userMessage
		});
	} catch (error) {
		return {
			agentTranscript: [],
			kind: 'failed',
			reason: `agent threw: ${errorMessage(error)}`
		};
	}

	const { emitted } = emitState;
	if (!emitted) {
		return {
			agentTranscript: result.transcript,
			kind: 'abandoned',
			reason: `agent did not emit a terminal decision (stopReason=${result.stopReason}, turns=${result.turns})`
		};
	}

	if (emitted.kind === 'fixed') {
		return {
			agentTranscript: result.transcript,
			kind: 'fixed',
			sourceTs: emitted.sourceTs,
			summary: emitted.summary
		};
	}

	return {
		agentTranscript: result.transcript,
		category: emitted.category,
		kind: 'unhealable',
		reason: emitted.reason
	};
}
