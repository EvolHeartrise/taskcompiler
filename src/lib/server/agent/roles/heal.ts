import {
	DEFAULT_MODEL,
	runAgent,
	type AgentEvent,
	type AgentRunResult,
	type Tool,
} from "../index.ts";
import { getWorkflow } from "$lib/server/db/queries/workflows";
import { getCurrentVersion } from "$lib/server/db/queries/versions";
import {
	getEvent,
	listAllEventsForWorkflow,
} from "$lib/server/db/queries/events";
import {
	getRun,
	listFailedRunsForWorkflow,
} from "$lib/server/db/queries/runs";
import { runAgainstEventEphemeral } from "$lib/server/engine/test-runner";
import type { Event, RunError, RunLogEntry } from "$lib/server/db/types";

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

export interface HealOutcome {
	status: "success" | "failed" | "abandoned";
	newVersionId?: string;
	diff?: string;
	testResults: {
		total: number;
		passed: number;
		failed: number;
		details: HealTestDetail[];
	};
	agentTranscript: AgentEvent[];
	reason?: string;
	sourceTs?: string;
}

interface EmittedPayload {
	sourceTs: string;
	summary: string;
}

export const HEAL_SYSTEM_PROMPT = `You are Runely's workflow healer. A user workflow just failed — your job is to produce a corrected version.

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
- emit_fixed_workflow: terminal. Call exactly once with the full corrected module source.

## Principles
- Diagnose first. Read the error + stack + logs and inspect the failing event payload. Form a hypothesis. THEN read the source.
- Change as little as possible. Do not rewrite the workflow. Patch the specific bug.
- The most common failure classes: unvalidated event shape, missing ctx.secret, bad HTTP status not checked, JSON parse on a non-JSON response, undefined path in event.
- After your fix, run_test_event on the failing event AND at least two historical events to confirm no regressions.
- Keep the run fail-fast semantics — don't swallow exceptions.

When confident, call emit_fixed_workflow exactly once. Do not emit partial or placeholder code.`;

const EXPORT_DEFAULT_RE =
	/export\s+default\s+(async\s+function|function\s+\w*\s*\(|(async\s+)?\([^)]*\)\s*=>|(async\s+)?[A-Za-z_$][\w$]*\s*=>)/;

const TWO_ARG_RE =
	/export\s+default\s+(?:async\s+)?(?:function\s*\w*\s*)?\(\s*[^,)\s]+\s*(?::[^,)]*)?\s*,\s*[^,)\s]+/;

function validateSource(source: string): { ok: true } | { ok: false; error: string } {
	if (typeof source !== "string" || source.trim().length === 0) {
		return { ok: false, error: "source_ts is empty" };
	}
	if (!source.includes("export default")) {
		return {
			ok: false,
			error: "source must contain a default export (missing `export default`)",
		};
	}
	if (!EXPORT_DEFAULT_RE.test(source)) {
		return {
			ok: false,
			error:
				"default export must be an async function or arrow function. Expected `export default async function run(event, ctx) { ... }` or `export default async (event, ctx) => { ... }`",
		};
	}
	if (!TWO_ARG_RE.test(source)) {
		return {
			ok: false,
			error:
				"default export must accept two parameters (event, ctx). Got a signature with fewer parameters.",
		};
	}
	return { ok: true };
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + `… [truncated ${s.length - max} chars]`;
}

function previewPayload(payload: unknown, max = 200): string {
	let str: string;
	try {
		str = JSON.stringify(payload);
	} catch {
		str = String(payload);
	}
	if (str === undefined) str = "undefined";
	return truncate(str, max);
}

function prettyJson(value: unknown, max = 4000): string {
	let str: string;
	try {
		str = JSON.stringify(value, null, 2);
	} catch {
		str = String(value);
	}
	if (str === undefined) str = "undefined";
	return truncate(str, max);
}

function getStringProp(obj: Record<string, unknown>, key: string): string | null {
	const v = obj[key];
	return typeof v === "string" ? v : null;
}

function getNumberProp(obj: Record<string, unknown>, key: string): number | null {
	const v = obj[key];
	return typeof v === "number" && Number.isFinite(v) ? v : null;
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
}): string {
	const parts: string[] = [];
	parts.push(`Workflow: ${args.workflowName} (id=${args.workflowId})`);
	parts.push("");
	parts.push("## Original user prompt");
	parts.push(args.userPrompt || "(none)");
	parts.push("");
	parts.push("## Current source");
	parts.push("```ts");
	parts.push(truncate(args.currentSource, 8000));
	parts.push("```");
	parts.push("");
	parts.push("## Triggering failed run");
	if (args.triggeringError) {
		parts.push(`error.name: ${args.triggeringError.name}`);
		parts.push(`error.message: ${args.triggeringError.message}`);
		if (args.triggeringError.stack) {
			parts.push("error.stack:");
			parts.push("```");
			parts.push(truncate(args.triggeringError.stack, 2000));
			parts.push("```");
		}
	} else {
		parts.push("(no error recorded)");
	}
	parts.push("");
	parts.push("## Logs from that run");
	parts.push("```json");
	parts.push(prettyJson(args.triggeringLogs ?? [], 3000));
	parts.push("```");
	parts.push("");
	parts.push("## Failed event payload");
	if (args.failedEvent) {
		parts.push(
			`event.id=${args.failedEvent.id}, triggerType=${args.failedEvent.triggerType}, receivedAt=${args.failedEvent.receivedAt}`,
		);
		parts.push("```json");
		parts.push(prettyJson(args.failedEvent.payload, 3000));
		parts.push("```");
	} else {
		parts.push("(event not found)");
	}
	parts.push("");
	parts.push(`## Historical events available: ${args.historicalEventCount}`);
	parts.push("");
	parts.push(
		"Diagnose the root cause. Use `read_source`, `list_events`, `get_event`, `list_failed_runs`, `get_run`, `run_test_event` to explore. When you have a fix, call `emit_fixed_workflow` ONCE with the complete new module source. Your fix must not throw on any historical event — the orchestrator will verify. Prefer minimal, surgical changes.",
	);
	return parts.join("\n");
}

function makeReadSourceTool(sourceTs: string): Tool {
	return {
		name: "read_source",
		description:
			"Read the current workflow TypeScript source. Returns the full module text.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		async run(): Promise<string> {
			return sourceTs;
		},
	};
}

function makeListEventsTool(workflowId: string): Tool {
	return {
		name: "list_events",
		description:
			"List historical events for this workflow in chronological (ascending) order. Returns id, receivedAt, triggerType and a short payload preview.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "Max number of events to return. Default 20.",
				},
			},
			additionalProperties: false,
		},
		async run(input: unknown): Promise<string> {
			const obj = (input && typeof input === "object" ? input : {}) as Record<
				string,
				unknown
			>;
			const limit = getNumberProp(obj, "limit") ?? 20;
			const all = await listAllEventsForWorkflow(workflowId);
			const slice = all.slice(-Math.max(1, Math.floor(limit)));
			const out = slice.map((e) => ({
				id: e.id,
				receivedAt: e.receivedAt,
				triggerType: e.triggerType,
				payloadPreview: previewPayload(e.payload, 200),
			}));
			return JSON.stringify({ total: all.length, returned: out.length, events: out });
		},
	};
}

function makeGetEventTool(workflowId: string): Tool {
	return {
		name: "get_event",
		description:
			"Fetch full details of a single event (including payload) by id. The event must belong to this workflow.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Event id" },
			},
			required: ["id"],
			additionalProperties: false,
		},
		async run(input: unknown): Promise<string> {
			const obj = (input && typeof input === "object" ? input : {}) as Record<
				string,
				unknown
			>;
			const id = getStringProp(obj, "id");
			if (!id) throw new Error("get_event: `id` is required");
			const event = await getEvent(id);
			if (!event) throw new Error(`get_event: event not found: ${id}`);
			if (event.workflowId !== workflowId) {
				throw new Error(`get_event: event does not belong to this workflow`);
			}
			return JSON.stringify({
				id: event.id,
				receivedAt: event.receivedAt,
				triggerType: event.triggerType,
				payload: event.payload,
			});
		},
	};
}

function makeListFailedRunsTool(workflowId: string): Tool {
	return {
		name: "list_failed_runs",
		description:
			"List recent failed runs for this workflow. Returns runId, eventId, startedAt, and error summary.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "Max number of runs to return. Default 10.",
				},
			},
			additionalProperties: false,
		},
		async run(input: unknown): Promise<string> {
			const obj = (input && typeof input === "object" ? input : {}) as Record<
				string,
				unknown
			>;
			const limit = getNumberProp(obj, "limit") ?? 10;
			const all = await listFailedRunsForWorkflow(workflowId);
			const slice = all.slice(0, Math.max(1, Math.floor(limit)));
			const out = slice.map((r) => ({
				runId: r.id,
				eventId: r.eventId,
				startedAt: r.startedAt,
				error: r.error,
			}));
			return JSON.stringify({ total: all.length, returned: out.length, runs: out });
		},
	};
}

function makeGetRunTool(workflowId: string): Tool {
	return {
		name: "get_run",
		description:
			"Fetch a full run including logs by id. The run must belong to this workflow.",
		inputSchema: {
			type: "object",
			properties: {
				runId: { type: "string", description: "Run id" },
			},
			required: ["runId"],
			additionalProperties: false,
		},
		async run(input: unknown): Promise<string> {
			const obj = (input && typeof input === "object" ? input : {}) as Record<
				string,
				unknown
			>;
			const runId = getStringProp(obj, "runId");
			if (!runId) throw new Error("get_run: `runId` is required");
			const run = await getRun(runId);
			if (!run) throw new Error(`get_run: run not found: ${runId}`);
			if (run.workflowId !== workflowId) {
				throw new Error("get_run: run does not belong to this workflow");
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
				isReplay: run.isReplay,
			});
		},
	};
}

function makeRunTestEventTool(workflowId: string): Tool {
	return {
		name: "run_test_event",
		description:
			"Run a candidate TS source against a specific historical event in isolation. Each call deploys a temporary Worker, invokes it, and tears it down — costs a few seconds of upload latency. Don't burn budget testing trivial things; use it to validate your final candidate against the failing event and a couple of historical ones. Returns { ok, error?, logs_tail } (last 20 log entries).",
		inputSchema: {
			type: "object",
			properties: {
				event_id: { type: "string", description: "Historical event id to test against" },
				source_ts: {
					type: "string",
					description: "Candidate TypeScript workflow source to test",
				},
			},
			required: ["event_id", "source_ts"],
			additionalProperties: false,
		},
		async run(input: unknown): Promise<string> {
			const obj = (input && typeof input === "object" ? input : {}) as Record<
				string,
				unknown
			>;
			const eventId = getStringProp(obj, "event_id");
			const sourceTs = getStringProp(obj, "source_ts");
			if (!eventId) throw new Error("run_test_event: `event_id` is required");
			if (!sourceTs) throw new Error("run_test_event: `source_ts` is required");
			const event = await getEvent(eventId);
			if (!event) throw new Error(`run_test_event: event not found: ${eventId}`);
			if (event.workflowId !== workflowId) {
				throw new Error("run_test_event: event does not belong to this workflow");
			}
			const workflow = await getWorkflow(workflowId);
			if (!workflow) throw new Error(`run_test_event: workflow not found: ${workflowId}`);
			const res = await runAgainstEventEphemeral(sourceTs, event, workflow);
			const tail = res.logs.slice(-20);
			return JSON.stringify({
				ok: res.ok,
				error: res.error,
				durationMs: res.durationMs,
				logs_tail: tail,
			});
		},
	};
}

function makeEmitFixedWorkflowTool(
	state: { attempts: number; emitted: EmittedPayload | null },
	maxAttempts: number,
): Tool {
	return {
		name: "emit_fixed_workflow",
		description:
			"Deliver the corrected workflow. Call this EXACTLY ONCE with the full TypeScript module source and a short summary of the fix. This is the only way to finish the task.",
		inputSchema: {
			type: "object",
			properties: {
				source_ts: {
					type: "string",
					description:
						"Full TypeScript source of the corrected workflow module. Must export a default async function `run(event, ctx)`.",
				},
				summary: {
					type: "string",
					description: "One-sentence summary of the fix (what was wrong, what changed).",
				},
			},
			required: ["source_ts", "summary"],
			additionalProperties: false,
		},
		async run(input: unknown): Promise<string> {
			if (input === null || typeof input !== "object") {
				throw new Error("emit_fixed_workflow: expected an object input");
			}
			const obj = input as Record<string, unknown>;
			const source = obj.source_ts;
			const summary = obj.summary;
			if (typeof source !== "string") {
				throw new Error("emit_fixed_workflow: `source_ts` must be a string");
			}
			if (typeof summary !== "string") {
				throw new Error("emit_fixed_workflow: `summary` must be a string");
			}
			state.attempts += 1;
			const validation = validateSource(source);
			if (!validation.ok) {
				if (state.attempts >= maxAttempts) {
					throw new Error(
						`${validation.error}. Max emit attempts (${maxAttempts}) exhausted.`,
					);
				}
				throw new Error(
					`${validation.error}. Fix the source and call emit_fixed_workflow again.`,
				);
			}
			state.emitted = { sourceTs: source, summary };
			throw new EmitSuccess(state.emitted);
		},
	};
}

export async function healWorkflow(opts: HealOptions): Promise<HealOutcome> {
	const emptyTestResults = { total: 0, passed: 0, failed: 0, details: [] };

	const workflow = await getWorkflow(opts.workflowId);
	if (!workflow) {
		return {
			status: "failed",
			testResults: emptyTestResults,
			agentTranscript: [],
			reason: `workflow not found: ${opts.workflowId}`,
		};
	}

	const currentVersion = await getCurrentVersion(opts.workflowId);
	if (!currentVersion) {
		return {
			status: "failed",
			testResults: emptyTestResults,
			agentTranscript: [],
			reason: `workflow has no current version: ${opts.workflowId}`,
		};
	}

	const currentSource = currentVersion.sourceTs;

	const triggeringRun = await getRun(opts.triggeringRunId);
	const failedEvent = triggeringRun ? await getEvent(triggeringRun.eventId) : null;
	const historicalEventCount = (await listAllEventsForWorkflow(opts.workflowId)).length;

	const userMessage = buildUserMessage({
		workflowName: workflow.name,
		workflowId: workflow.id,
		userPrompt: workflow.prompt,
		currentSource,
		triggeringError: triggeringRun?.error ?? null,
		triggeringLogs: triggeringRun?.logs ?? null,
		failedEvent,
		historicalEventCount,
	});

	const emitState: { attempts: number; emitted: EmittedPayload | null } = {
		attempts: 0,
		emitted: null,
	};
	const controller = new AbortController();

	const rawEmitTool = makeEmitFixedWorkflowTool(emitState, 2);
	const emitTool: Tool = {
		...rawEmitTool,
		async run(input, ctx) {
			try {
				return await rawEmitTool.run(input, ctx);
			} catch (err) {
				if (err instanceof EmitSuccess) {
					controller.abort();
					return `ok: fix received (${err.payload.summary})`;
				}
				throw err;
			}
		},
	};

	const tools: Tool[] = [
		makeReadSourceTool(currentSource),
		makeListEventsTool(opts.workflowId),
		makeGetEventTool(opts.workflowId),
		makeListFailedRunsTool(opts.workflowId),
		makeGetRunTool(opts.workflowId),
		makeRunTestEventTool(opts.workflowId),
		emitTool,
	];

	let result: AgentRunResult;
	try {
		result = await runAgent({
			model: opts.model ?? DEFAULT_MODEL,
			systemPrompt: HEAL_SYSTEM_PROMPT,
			userMessage,
			tools,
			maxTurns: opts.maxTurns ?? 50,
			onEvent: opts.onEvent,
			abortSignal: controller.signal,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: "failed",
			testResults: emptyTestResults,
			agentTranscript: [],
			reason: `agent threw: ${message}`,
		};
	}

	if (!emitState.emitted) {
		return {
			status: "abandoned",
			testResults: emptyTestResults,
			agentTranscript: result.transcript,
			reason: `agent did not emit a fix (stopReason=${result.stopReason}, turns=${result.turns})`,
		};
	}

	return {
		status: "success",
		sourceTs: emitState.emitted.sourceTs,
		testResults: emptyTestResults,
		agentTranscript: result.transcript,
		reason: emitState.emitted.summary,
	};
}
