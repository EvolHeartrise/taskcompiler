import {
	type AgentEvent,
	type AgentRunResult,
	DEFAULT_MODEL,
	type Tool,
	runAgent
} from '../index.ts';
import { getWorkflow } from '$lib/server/db/queries/workflows';
import { getCurrentVersion } from '$lib/server/db/queries/versions';
import { getEvent, listAllEventsForWorkflow } from '$lib/server/db/queries/events';
import { getRun, listFailedRunsForWorkflow } from '$lib/server/db/queries/runs';
import { listSecretNamesForUser } from '$lib/server/db/queries/secrets';
import { runAgainstEventEphemeral } from '$lib/server/engine/test-runner';
import type { Event, RunError, RunLogEntry, UnhealableCategory } from '$lib/server/db/types';

export interface HealOptions {
	workflowId: string;
	triggeringRunId: string;
	model?: string;
	onEvent?: (e: AgentEvent) => void;
	maxTurns?: number;
}

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

No imports from node_modules, no relative imports. \`event\` is \`unknown\` — validate it.

## Your tools
- read_source: current workflow TS
- list_events / get_event: inspect historical events for this workflow
- list_failed_runs / get_run: inspect recent failures
- run_test_event: run a candidate source against a specific historical event in isolation (deploys and tears down a temp Worker per call). Each call costs a few seconds of upload latency, so don't burn budget testing trivial things — use it to validate your final candidate against the failing event and a couple of historical ones.
- emit_fixed_workflow: terminal. Call when a code change fixes the failure.
- emit_unhealable: terminal. Call when the failure is NOT fixable by changing workflow code (see below).

## Principles
- Diagnose first. Read the error + stack + logs and inspect the failing event payload. Form a hypothesis. THEN read the source.
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

Do not emit partial or placeholder code. Call exactly ONE terminal tool (emit_fixed_workflow or emit_unhealable).`;

const EXPORT_DEFAULT_RE =
	/export\s+default\s+(async\s+function|function\s+\w*\s*\(|(async\s+)?\([^)]*\)\s*=>|(async\s+)?[A-Za-z_$][\w$]*\s*=>)/;

const TWO_ARG_RE =
	/export\s+default\s+(?:async\s+)?(?:function\s*\w*\s*)?\(\s*[^,)\s]+\s*(?::[^,)]*)?\s*,\s*[^,)\s]+/;

function validateSource(source: string): { ok: true } | { ok: false; error: string } {
	if (typeof source !== 'string' || source.trim().length === 0) {
		return { error: 'source_ts is empty', ok: false };
	}
	if (!source.includes('export default')) {
		return {
			error: 'source must contain a default export (missing `export default`)',
			ok: false
		};
	}
	if (!EXPORT_DEFAULT_RE.test(source)) {
		return {
			error:
				'default export must be an async function or arrow function. Expected `export default async function run(event, ctx) { ... }` or `export default async (event, ctx) => { ... }`',
			ok: false
		};
	}
	if (!TWO_ARG_RE.test(source)) {
		return {
			error:
				'default export must accept two parameters (event, ctx). Got a signature with fewer parameters.',
			ok: false
		};
	}
	return { ok: true };
}

function truncate(s: string, max: number): string {
	if (s.length <= max) {
		return s;
	}
	return `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

function previewPayload(payload: unknown, max = 200): string {
	let str: string;
	try {
		str = JSON.stringify(payload);
	} catch {
		str = String(payload);
	}
	if (str === undefined) {
		str = 'undefined';
	}
	return truncate(str, max);
}

function prettyJson(value: unknown, max = 4000): string {
	let str: string;
	try {
		str = JSON.stringify(value, null, 2);
	} catch {
		str = String(value);
	}
	if (str === undefined) {
		str = 'undefined';
	}
	return truncate(str, max);
}

function getStringProp(obj: Record<string, unknown>, key: string): string | null {
	const v = obj[key];
	return typeof v === 'string' ? v : null;
}

function getNumberProp(obj: Record<string, unknown>, key: string): number | null {
	const v = obj[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

class EmitSuccess {
	constructor(public readonly payload: EmittedPayload) {}
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
	parts.push(prettyJson(args.triggeringLogs ?? [], 3000));
	parts.push('```');
	parts.push('');
	parts.push('## Failed event payload');
	if (args.failedEvent) {
		parts.push(
			`event.id=${args.failedEvent.id}, triggerType=${args.failedEvent.triggerType}, receivedAt=${args.failedEvent.receivedAt}`
		);
		parts.push('```json');
		parts.push(prettyJson(args.failedEvent.payload, 3000));
		parts.push('```');
	} else {
		parts.push('(event not found)');
	}
	parts.push('');
	parts.push(`## Historical events available: ${args.historicalEventCount}`);
	parts.push('');
	parts.push(
		'Diagnose the root cause. Use `read_source`, `list_events`, `get_event`, `list_failed_runs`, `get_run`, `run_test_event` to explore. When you have a fix, call `emit_fixed_workflow` ONCE with the complete new module source. Your fix must not throw on any historical event — the orchestrator will verify. Prefer minimal, surgical changes.'
	);
	return parts.join('\n');
}

function makeReadSourceTool(sourceTs: string): Tool {
	return {
		description: 'Read the current workflow TypeScript source. Returns the full module text.',
		inputSchema: {
			additionalProperties: false,
			properties: {},
			type: 'object'
		},
		name: 'read_source',
		async run(): Promise<string> {
			return sourceTs;
		}
	};
}

function makeListEventsTool(workflowId: string): Tool {
	return {
		description:
			'List historical events for this workflow in chronological (ascending) order. Returns id, receivedAt, triggerType and a short payload preview.',
		inputSchema: {
			additionalProperties: false,
			properties: {
				limit: {
					description: 'Max number of events to return. Default 20.',
					type: 'number'
				}
			},
			type: 'object'
		},
		name: 'list_events',
		async run(input: unknown): Promise<string> {
			const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
			const limit = getNumberProp(obj, 'limit') ?? 20;
			const all = await listAllEventsForWorkflow(workflowId);
			const slice = all.slice(-Math.max(1, Math.floor(limit)));
			const out = slice.map((e) => ({
				id: e.id,
				receivedAt: e.receivedAt,
				triggerType: e.triggerType,
				payloadPreview: previewPayload(e.payload, 200)
			}));
			return JSON.stringify({ total: all.length, returned: out.length, events: out });
		}
	};
}

function makeGetEventTool(workflowId: string): Tool {
	return {
		description:
			'Fetch full details of a single event (including payload) by id. The event must belong to this workflow.',
		inputSchema: {
			additionalProperties: false,
			properties: {
				id: { description: 'Event id', type: 'string' }
			},
			required: ['id'],
			type: 'object'
		},
		name: 'get_event',
		async run(input: unknown): Promise<string> {
			const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
			const id = getStringProp(obj, 'id');
			if (!id) throw new Error('get_event: `id` is required');
			const event = await getEvent(id);
			if (!event) throw new Error(`get_event: event not found: ${id}`);
			if (event.workflowId !== workflowId) {
				throw new Error(`get_event: event does not belong to this workflow`);
			}
			return JSON.stringify({
				id: event.id,
				receivedAt: event.receivedAt,
				triggerType: event.triggerType,
				payload: event.payload
			});
		}
	};
}

function makeListFailedRunsTool(workflowId: string): Tool {
	return {
		description:
			'List recent failed runs for this workflow. Returns runId, eventId, startedAt, and error summary.',
		inputSchema: {
			additionalProperties: false,
			properties: {
				limit: {
					description: 'Max number of runs to return. Default 10.',
					type: 'number'
				}
			},
			type: 'object'
		},
		name: 'list_failed_runs',
		async run(input: unknown): Promise<string> {
			const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
			const limit = getNumberProp(obj, 'limit') ?? 10;
			const all = await listFailedRunsForWorkflow(workflowId);
			const slice = all.slice(0, Math.max(1, Math.floor(limit)));
			const out = slice.map((r) => ({
				runId: r.id,
				eventId: r.eventId,
				startedAt: r.startedAt,
				error: r.error
			}));
			return JSON.stringify({ total: all.length, returned: out.length, runs: out });
		}
	};
}

function makeGetRunTool(workflowId: string): Tool {
	return {
		description: 'Fetch a full run including logs by id. The run must belong to this workflow.',
		inputSchema: {
			additionalProperties: false,
			properties: {
				runId: { description: 'Run id', type: 'string' }
			},
			required: ['runId'],
			type: 'object'
		},
		name: 'get_run',
		async run(input: unknown): Promise<string> {
			const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
			const runId = getStringProp(obj, 'runId');
			if (!runId) throw new Error('get_run: `runId` is required');
			const run = await getRun(runId);
			if (!run) throw new Error(`get_run: run not found: ${runId}`);
			if (run.workflowId !== workflowId) {
				throw new Error('get_run: run does not belong to this workflow');
			}
			return JSON.stringify({
				id: run.id,
				eventId: run.eventId,
				versionId: run.versionId,
				status: run.status,
				startedAt: run.startedAt,
				finishedAt: run.finishedAt,
				error: run.error,
				result: run.result,
				logs: run.logs ?? [],
				isReplay: run.isReplay
			});
		}
	};
}

function makeRunTestEventTool(workflowId: string): Tool {
	return {
		description:
			"Run a candidate TS source against a specific historical event in isolation. Each call deploys a temporary Worker, invokes it, and tears it down — costs a few seconds of upload latency. Don't burn budget testing trivial things; use it to validate your final candidate against the failing event and a couple of historical ones. Returns { ok, error?, logs_tail } (last 20 log entries).",
		inputSchema: {
			additionalProperties: false,
			properties: {
				event_id: { description: 'Historical event id to test against', type: 'string' },
				source_ts: {
					description: 'Candidate TypeScript workflow source to test',
					type: 'string'
				}
			},
			required: ['event_id', 'source_ts'],
			type: 'object'
		},
		name: 'run_test_event',
		async run(input: unknown): Promise<string> {
			const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
			const eventId = getStringProp(obj, 'event_id');
			const sourceTs = getStringProp(obj, 'source_ts');
			if (!eventId) throw new Error('run_test_event: `event_id` is required');
			if (!sourceTs) throw new Error('run_test_event: `source_ts` is required');
			const event = await getEvent(eventId);
			if (!event) throw new Error(`run_test_event: event not found: ${eventId}`);
			if (event.workflowId !== workflowId) {
				throw new Error('run_test_event: event does not belong to this workflow');
			}
			const workflow = await getWorkflow(workflowId);
			if (!workflow) throw new Error(`run_test_event: workflow not found: ${workflowId}`);
			const res = await runAgainstEventEphemeral(sourceTs, event, workflow);
			const tail = res.logs.slice(-20);
			return JSON.stringify({
				ok: res.ok,
				error: res.error,
				durationMs: res.durationMs,
				logs_tail: tail
			});
		}
	};
}

function makeEmitFixedWorkflowTool(
	state: { attempts: number; emitted: EmittedPayload | null },
	maxAttempts: number
): Tool {
	return {
		description:
			'Deliver the corrected workflow. Call this EXACTLY ONCE with the full TypeScript module source and a short summary of the fix. This is the only way to finish the task for a code-fixable failure.',
		inputSchema: {
			additionalProperties: false,
			properties: {
				source_ts: {
					description:
						'Full TypeScript source of the corrected workflow module. Must export a default async function `run(event, ctx)`.',
					type: 'string'
				},
				summary: {
					description: 'One-sentence summary of the fix (what was wrong, what changed).',
					type: 'string'
				}
			},
			required: ['source_ts', 'summary'],
			type: 'object'
		},
		name: 'emit_fixed_workflow',
		async run(input: unknown): Promise<string> {
			if (input === null || typeof input !== 'object') {
				throw new Error('emit_fixed_workflow: expected an object input');
			}
			const obj = input as Record<string, unknown>;
			const source = obj.source_ts;
			const summary = obj.summary;
			if (typeof source !== 'string') {
				throw new TypeError('emit_fixed_workflow: `source_ts` must be a string');
			}
			if (typeof summary !== 'string') {
				throw new TypeError('emit_fixed_workflow: `summary` must be a string');
			}
			state.attempts += 1;
			const validation = validateSource(source);
			if (!validation.ok) {
				if (state.attempts >= maxAttempts) {
					throw new Error(`${validation.error}. Max emit attempts (${maxAttempts}) exhausted.`);
				}
				throw new Error(`${validation.error}. Fix the source and call emit_fixed_workflow again.`);
			}
			state.emitted = { kind: 'fixed', sourceTs: source, summary };
			throw new EmitSuccess(state.emitted);
		}
	};
}

function makeEmitUnhealableTool(state: { emitted: EmittedPayload | null }): Tool {
	return {
		description:
			"Declare the failure is not fixable by changing workflow code. Call this EXACTLY ONCE with a category and an evidence-backed reason. Only use after you've read the source and formed a concrete hypothesis about why no code change would help.",
		inputSchema: {
			additionalProperties: false,
			properties: {
				category: {
					description: 'third_party_outage | credential | input_malformed | capability_gap | other',
					enum: [...UNHEALABLE_CATEGORIES],
					type: 'string'
				},
				reason: {
					description:
						'Evidence-backed explanation: specific error text, observed behavior, or response body that demonstrates the cause is external to the workflow code. 1–3 sentences.',
					type: 'string'
				}
			},
			required: ['category', 'reason'],
			type: 'object'
		},
		name: 'emit_unhealable',
		async run(input: unknown): Promise<string> {
			if (input === null || typeof input !== 'object') {
				throw new Error('emit_unhealable: expected an object input');
			}
			const obj = input as Record<string, unknown>;
			const category = obj.category;
			const reason = obj.reason;
			if (typeof category !== 'string') {
				throw new TypeError('emit_unhealable: `category` must be a string');
			}
			if (!UNHEALABLE_CATEGORIES.includes(category as UnhealableCategory)) {
				throw new Error(
					`emit_unhealable: \`category\` must be one of ${UNHEALABLE_CATEGORIES.join(', ')}`
				);
			}
			if (typeof reason !== 'string' || reason.trim().length === 0) {
				throw new Error('emit_unhealable: `reason` must be a non-empty string');
			}
			state.emitted = {
				kind: 'unhealable',
				category: category as UnhealableCategory,
				reason: reason.trim()
			};
			throw new EmitSuccess(state.emitted);
		}
	};
}

export async function healWorkflow(opts: HealOptions): Promise<HealOutcome> {
	const workflow = await getWorkflow(opts.workflowId);
	if (!workflow) {
		return {
			agentTranscript: [],
			kind: 'failed',
			reason: `workflow not found: ${opts.workflowId}`
		};
	}

	const currentVersion = await getCurrentVersion(opts.workflowId);
	if (!currentVersion) {
		return {
			agentTranscript: [],
			kind: 'failed',
			reason: `workflow has no current version: ${opts.workflowId}`
		};
	}

	const currentSource = currentVersion.sourceTs;

	const triggeringRun = await getRun(opts.triggeringRunId);
	const failedEvent = triggeringRun ? await getEvent(triggeringRun.eventId) : null;
	const historicalEventCount = (await listAllEventsForWorkflow(opts.workflowId)).length;
	const secretMetas = await listSecretNamesForUser(workflow.userId);

	const userMessage = buildUserMessage({
		availableSecrets: secretMetas.map((s) => s.name),
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

	function wrapTerminal(tool: Tool): Tool {
		return {
			...tool,
			async run(input, ctx) {
				try {
					return await tool.run(input, ctx);
				} catch (error) {
					if (error instanceof EmitSuccess) {
						controller.abort();
						if (error.payload.kind === 'fixed') {
							return `ok: fix received (${error.payload.summary})`;
						}
						return `ok: escalated as unhealable (${error.payload.category})`;
					}
					throw error;
				}
			}
		};
	}

	const tools: Tool[] = [
		makeReadSourceTool(currentSource),
		makeListEventsTool(opts.workflowId),
		makeGetEventTool(opts.workflowId),
		makeListFailedRunsTool(opts.workflowId),
		makeGetRunTool(opts.workflowId),
		makeRunTestEventTool(opts.workflowId),
		wrapTerminal(makeEmitFixedWorkflowTool(emitState, 2)),
		wrapTerminal(makeEmitUnhealableTool(emitState))
	];

	let result: AgentRunResult;
	try {
		result = await runAgent({
			abortSignal: controller.signal,
			maxTurns: opts.maxTurns ?? 50,
			model: opts.model ?? DEFAULT_MODEL,
			onEvent: opts.onEvent,
			systemPrompt: HEAL_SYSTEM_PROMPT,
			tools,
			userMessage
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			agentTranscript: [],
			kind: 'failed',
			reason: `agent threw: ${message}`
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
