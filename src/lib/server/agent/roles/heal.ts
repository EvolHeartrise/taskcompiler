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

const UNHEALABLE_CATEGORIES: readonly UnhealableCategory[] = [
	'third_party_outage',
	'credential',
	'input_malformed',
	'capability_gap',
	'other'
];

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
- emit_unhealable: terminal. Call when the failure is NOT fixable by changing workflow code (see below).

## Principles
- Diagnose first. Read the error + stack + logs and inspect the failing event payload against the source. Form a hypothesis before editing.
- Change as little as possible. Do not rewrite the workflow. Patch the specific bug.
- The most common failure classes: unvalidated event shape, missing ctx.secret, bad HTTP status not checked, JSON parse on a non-JSON response, undefined path in event.
- After your fix, run_test_event on the failing event AND at least two historical events to confirm no regressions.
- Keep the run fail-fast semantics — don't swallow exceptions.

## When to emit_unhealable instead of fixing
Strongly prefer fixing. Only escalate when you are confident no code change will resolve the failure. Before calling emit_unhealable you MUST have:
  1. Read the source and the triggering error.
  2. Formed a concrete hypothesis about WHY no code change would work.
  3. Included the evidence in \`reason\` (specific error text, response body, or observed behavior that demonstrates the cause is external).

Use one of these categories:
- \`third_party_outage\`: an upstream API the workflow depends on is down, 5xx-ing, or returning errors indicating their side is broken. Don't use this just because a fetch failed once — the code should usually be taught to retry. Use it when the pattern clearly shows the third party, not the code.
- \`credential\`: the workflow is using a secret (via ctx.secret) that is missing, expired, or unauthorized (401/403 from the upstream with a clear message). The user must rotate or provide the secret.
- \`input_malformed\`: incoming events are structurally unlike anything the workflow was built to handle, and changing the workflow would change its intent. The user must fix the producer or reframe the prompt.
- \`capability_gap\`: the workflow is being asked to do something that can't be done through the Runely ctx surface (no filesystem, no spawn, no specific binding). The user must change their goal.
- \`other\`: none of the above, but clearly not code-fixable. Use sparingly; include a thorough reason.

If you're not sure, attempt a fix first. A wrong fix is usually cheaper than a wrong escalation — the user sees an escalation as "something is blocking my workflow" and acts on it.

Do not emit partial or placeholder code. Call exactly ONE terminal tool (emit_fixed_workflow or emit_unhealable).

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
	historicalEventCount: number;
	availableSecrets: string[];
}): string {
	const parts: string[] = [];
	parts.push(`Workflow: ${args.workflowName} (id=${args.workflowId})`);
	parts.push('');
	parts.push('## Original user prompt');
	parts.push(args.userPrompt || '(none)');
	parts.push('');
	parts.push('## Available secrets (via ctx.secret)');
	parts.push(
		args.availableSecrets.length === 0
			? '(none — if the failure is because a needed secret is missing, use emit_unhealable with category=credential)'
			: args.availableSecrets.map((n) => `- ${n}`).join('\n')
	);
	parts.push('');
	parts.push('## Current source');
	parts.push('```ts');
	parts.push(truncate(args.currentSource, 8000));
	parts.push('```');
	parts.push('');
	parts.push('## Triggering failed run');
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
	parts.push('## Logs from that run');
	parts.push('```json');
	parts.push(formatJson(args.triggeringLogs ?? [], { pretty: true, max: 3000 }));
	parts.push('```');
	parts.push('');
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
	parts.push(`## Historical events available: ${args.historicalEventCount}`);
	parts.push('');
	parts.push(
		'Diagnose the root cause. Use `list_events`, `get_event`, `list_failed_runs`, `get_run`, `run_test_event` to explore. When you have a fix, call `emit_fixed_workflow` ONCE with the complete new module source. Your fix must not throw on any historical event — the orchestrator will verify. Prefer minimal, surgical changes.'
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

function makeEmitUnhealableTool(state: { emitted: EmittedPayload | null }): Tool {
	return defineTool<{ category: UnhealableCategory; reason: string }>({
		name: 'emit_unhealable',
		description:
			"Declare the failure is not fixable by changing workflow code. Call this EXACTLY ONCE with a category and an evidence-backed reason. Only use after you've read the source and formed a concrete hypothesis about why no code change would help.",
		fields: {
			category: {
				kind: 'enum',
				description: 'third_party_outage | credential | input_malformed | capability_gap | other',
				values: UNHEALABLE_CATEGORIES
			},
			reason: {
				kind: 'string',
				description:
					'Evidence-backed explanation: specific error text, observed behavior, or response body that demonstrates the cause is external to the workflow code. 1–3 sentences.'
			}
		},
		required: ['category', 'reason'],
		async run({ category, reason }): Promise<string> {
			if (reason.trim().length === 0) {
				throw new Error('emit_unhealable: `reason` must be a non-empty string');
			}
			state.emitted = { category, kind: 'unhealable', reason: reason.trim() };
			throw new EmitSuccess(state.emitted);
		}
	});
}

function formatTerminal(payload: EmittedPayload): string {
	if (payload.kind === 'fixed') {
		return `ok: fix received (${payload.summary})`;
	}
	return `ok: escalated as unhealable (${payload.category})`;
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
	const historicalEventCount = (await listAllEventsForWorkflow(db, opts.workflowId)).length;
	const secretMetas = await listSecretNamesForProject(db, workflow.projectId);
	const secretNames = secretMetas.map((s) => s.name);

	const userMessage = buildUserMessage({
		availableSecrets: secretNames,
		currentSource,
		failedEvent,
		historicalEventCount,
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
		wrapTerminal<EmittedPayload>(makeEmitUnhealableTool(emitState), controller, formatTerminal)
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
