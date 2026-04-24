import { type AgentEvent, type AgentRunResult, DEFAULT_MODEL, runAgent } from '../loop.ts';
import type { Tool } from '../tools.ts';
import { defineTool } from '../tool-schema.ts';
import { getDb } from '$lib/server/db';
import { getWorkflow } from '$lib/server/db/queries/workflows';
import { getCurrentVersion } from '$lib/server/db/queries/versions';
import { getEvent, listAllEventsForWorkflow } from '$lib/server/db/queries/events';
import {
	getRun,
	listFailedRunsByEvent,
	listFailedRunsForWorkflow
} from '$lib/server/db/queries/runs';
import { listSecretNamesForProject } from '$lib/server/db/queries/secrets';
import { runAgainstEventEphemeral } from '$lib/server/engine/test-runner';
import { typecheckWorkflow } from '../typecheck/service';
import { EmitSuccess, wrapTerminal } from './shared.ts';
import { buildTriageBlock } from '$lib/server/healer/triage';
import { createLogger } from '$lib/server/log';
import { EVENTS } from '$lib/server/log-events';
import type {
	Event,
	RunError,
	RunLogEntry,
	UnhealableCategory,
	Workflow
} from '$lib/server/db/types';
import { errorMessage, truncate } from '$lib/server/util';

const log = createLogger('heal-submit');

export interface HealOptions {
	env: Env;
	workflowId: string;
	triggeringRunId: string;
	healSessionId?: string;
	model?: string;
	onEvent?: (e: AgentEvent) => void;
	maxTurns?: number;
	maxTokens?: number;
}

// Heal runs include the full candidate source in each submit_candidate_source
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
- list_events / get_event: inspect historical events for this workflow. These are read-only; if you need multiple events, emit all get_event calls in ONE turn (parallel tool use).
- list_failed_runs / get_run: inspect recent failures. Same rule — batch read-only reads in a single turn.
- submit_candidate_source: submit your candidate fix. The harness type-checks it, then runs it against every previously-failing event in chronological order. On the first test failure it returns structured feedback (event_id, payload preview, error, log_tail) — revise and resubmit. The next submit resumes testing from the failing event, so events already passed stay passed. When every failed event passes, the heal converges automatically.
- emit_cannot_fix: terminal. Call when the failure is NOT fixable by changing workflow code (upstream outage, missing/expired secret, structurally alien input, or a capability gap in the ctx surface). The tool description has the full criteria.

## Principles
- Diagnose first. Read the error + stack + logs and inspect the failing event payload against the source. A TRIAGE block at the top of the user message already classifies the error, shows the failing line's source context, and lists canary events with distinct payload shapes — skim it before calling any tools.
- Change as little as possible. Do not rewrite the workflow. Patch the specific bug.
- The most common failure classes: unvalidated event shape, missing ctx.secret, bad HTTP status not checked, JSON parse on a non-JSON response, undefined path in event.
- Keep the run fail-fast semantics — don't swallow exceptions.

## Convergence
Success comes from submit_candidate_source passing against every failed event — no separate "I'm done" signal is needed. If you decide the failure isn't code-fixable, call emit_cannot_fix instead. Strongly prefer fixing — a wrong escalation costs the user more than a wrong fix. Do not emit partial or placeholder code.

## Typecheck gate on submit_candidate_source
The source you submit is type-checked against the Ctx interface before any test runs. \`ctx.secret\` accepts only the project's current secret names (listed in the user message); a typo or unknown name is a TS error. If submit_candidate_source returns status="typecheck_failed" with diagnostics, read them, fix the code, and submit again.`;

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
		"Diagnose the root cause. The TRIAGE block above already classifies the error and shows source context for the failing line — don't re-derive those. Use `list_events`, `get_event`, `list_failed_runs`, `get_run` for exploration (batch parallel calls in one turn). When you're ready, call `submit_candidate_source` with the full fixed module. The harness will test it against every previously-failing event and either converge or return structured feedback. Prefer minimal, surgical changes."
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

interface SubmitCandidateDeps {
	env: Env;
	workflow: Workflow;
	failedEvents: readonly Event[];
	secretNames: readonly string[];
	healSessionId: string | undefined;
	state: { emitted: EmittedPayload | null };
}

interface SubmitCursor {
	passedEventIds: Set<string>;
	resumeEventId: string | null;
	lastSubmittedSource: string | null;
	submitCount: number;
}

function topLevelKeys(payload: unknown): string[] {
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
		return [];
	}
	return Object.keys(payload as Record<string, unknown>);
}

function payloadPreview(payload: unknown, max = 500): string {
	let str: string;
	try {
		str = JSON.stringify(payload);
	} catch {
		str = String(payload);
	}
	return truncate(str, max);
}

// Closure-scoped cursor. The tool is per-run (constructed inside
// healWorkflow), so this map lives exactly as long as one agent loop.
function makeSubmitCandidateSourceTool(deps: SubmitCandidateDeps): Tool {
	const cursor: SubmitCursor = {
		lastSubmittedSource: null,
		passedEventIds: new Set<string>(),
		resumeEventId: null,
		submitCount: 0
	};

	return defineTool<{ source_ts: string; summary: string }>({
		name: 'submit_candidate_source',
		description:
			'Submit a candidate workflow TypeScript source. The harness type-checks it, then runs it against every historical event that previously failed, in chronological order. On the first test failure it returns a structured result ({ status: "test_failed", event_id, event_position, event_payload_preview, error, log_tail, hint }); revise and resubmit — the next submit resumes from that event. If every failed event passes, the heal converges automatically and you DO NOT need to call any other terminal tool. Supply `summary` with a one-sentence description of the fix.',
		fields: {
			source_ts: {
				kind: 'string',
				description:
					'Full TypeScript source of the workflow module. Must export a default async function `run(event, ctx)`.'
			},
			summary: {
				kind: 'string',
				description: 'One-sentence summary of the fix applied.'
			}
		},
		required: ['source_ts', 'summary'],
		async run({ source_ts, summary }): Promise<string> {
			cursor.submitCount += 1;
			const submitIndex = cursor.submitCount;
			log.info(EVENTS.HEAL_SUBMIT_STARTED, {
				heal_session_id: deps.healSessionId,
				submit_index: submitIndex,
				total_failed_events: deps.failedEvents.length,
				passed_so_far: cursor.passedEventIds.size,
				resume_event_id: cursor.resumeEventId
			});

			// Typecheck first — a failing TS check is cheap to return and
			// avoids burning upload latency on a source that can't compile.
			const tc = typecheckWorkflow(deps.secretNames, source_ts);
			if (!tc.ok) {
				return JSON.stringify({
					status: 'typecheck_failed',
					diagnostics: tc.diagnostics,
					hint: 'Fix the TypeScript errors above and call submit_candidate_source again.'
				});
			}

			// Queue: events we haven't marked passed yet, in chronological order.
			// "Continue from failure": if we have a resumeEventId, start there;
			// otherwise start from the oldest un-passed failed event.
			const remaining = deps.failedEvents.filter((e) => !cursor.passedEventIds.has(e.id));

			if (remaining.length === 0) {
				// Nothing to test — treat this as converged. Shouldn't normally
				// happen (there would have been no heal trigger), but guard it.
				cursor.lastSubmittedSource = source_ts;
				deps.state.emitted = { kind: 'fixed', sourceTs: source_ts, summary };
				log.info(EVENTS.HEAL_SUBMIT_CONVERGED, {
					heal_session_id: deps.healSessionId,
					total_failed_events: 0,
					submits: submitIndex
				});
				throw new EmitSuccess(deps.state.emitted);
			}

			let startIdx = 0;
			if (cursor.resumeEventId !== null) {
				const idx = remaining.findIndex((e) => e.id === cursor.resumeEventId);
				if (idx >= 0) {
					startIdx = idx;
				}
			}

			const sameAsLast = cursor.lastSubmittedSource === source_ts;
			cursor.lastSubmittedSource = source_ts;

			for (let i = startIdx; i < remaining.length; i++) {
				const event = remaining[i]!;
				const totalPosition = deps.failedEvents.findIndex((e) => e.id === event.id) + 1;
				const positionStr = `${totalPosition} of ${deps.failedEvents.length}`;

				const res = await runAgainstEventEphemeral(deps.env, source_ts, event, deps.workflow);
				if (res.ok) {
					cursor.passedEventIds.add(event.id);
					log.info(EVENTS.HEAL_SUBMIT_EVENT_PASSED, {
						heal_session_id: deps.healSessionId,
						submit_index: submitIndex,
						event_id: event.id,
						event_position: positionStr,
						durationMs: res.durationMs
					});
					continue;
				}

				// Fail — park the cursor, emit feedback, let the agent revise.
				cursor.resumeEventId = event.id;
				log.info(EVENTS.HEAL_SUBMIT_EVENT_FAILED, {
					heal_session_id: deps.healSessionId,
					submit_index: submitIndex,
					event_id: event.id,
					event_position: positionStr,
					error_name: res.error?.name ?? null,
					error_message: res.error?.message ?? null
				});

				const response: Record<string, unknown> = {
					status: 'test_failed',
					event_id: event.id,
					event_position: positionStr,
					event_top_level_keys: topLevelKeys(event.payload),
					event_payload_preview: payloadPreview(event.payload),
					error: res.error
						? { name: res.error.name, message: res.error.message }
						: { name: 'Error', message: 'unknown error' },
					log_tail: res.logs.slice(-10),
					hint:
						'Revise the source and call submit_candidate_source again. The next submit resumes testing from this event; events already passed (' +
						cursor.passedEventIds.size +
						'/' +
						deps.failedEvents.length +
						') will not be re-tested.'
				};
				if (sameAsLast) {
					response.note =
						'Same source as your previous submit — the outcome is unchanged. Revise and resubmit.';
				}
				return JSON.stringify(response);
			}

			// All remaining failed events passed — converged.
			deps.state.emitted = { kind: 'fixed', sourceTs: source_ts, summary };
			log.info(EVENTS.HEAL_SUBMIT_CONVERGED, {
				heal_session_id: deps.healSessionId,
				total_failed_events: deps.failedEvents.length,
				submits: submitIndex
			});
			throw new EmitSuccess(deps.state.emitted);
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

	// Events to re-test against. One entry per distinct event where the most
	// recent run failed; oldest-first so the submit loop walks events in
	// chronological order. The triggering event is always included (it just
	// failed), and duplicates are collapsed by event_id.
	const failedRuns = await listFailedRunsByEvent(db, opts.workflowId);
	const failedEventIds = new Set<string>();
	const failedEventList: Event[] = [];
	for (const run of [...failedRuns].toSorted((a, b) => a.startedAt - b.startedAt)) {
		if (failedEventIds.has(run.eventId)) {
			continue;
		}
		const ev = await getEvent(db, run.eventId);
		if (!ev) {
			continue;
		}
		failedEventIds.add(ev.id);
		failedEventList.push(ev);
	}
	// Defensive: if for some reason the triggering event isn't in the failed
	// set (e.g. run status was updated mid-flight), append it so the agent's
	// candidate is at least tested against the event that triggered this heal.
	if (failedEvent && !failedEventIds.has(failedEvent.id)) {
		failedEventList.push(failedEvent);
		failedEventIds.add(failedEvent.id);
	}

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

	const emitState: { emitted: EmittedPayload | null } = { emitted: null };
	const controller = new AbortController();

	const tools: Tool[] = [
		makeListEventsTool(opts.env, opts.workflowId),
		makeGetEventTool(opts.env, opts.workflowId, workflow.eventSourceId),
		makeListFailedRunsTool(opts.env, opts.workflowId),
		makeGetRunTool(opts.env, opts.workflowId),
		wrapTerminal<EmittedPayload>(
			makeSubmitCandidateSourceTool({
				env: opts.env,
				failedEvents: failedEventList,
				healSessionId: opts.healSessionId,
				secretNames,
				state: emitState,
				workflow
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
