import {
	DEFAULT_MODEL,
	runAgent,
	type AgentEvent,
	type AgentRunResult,
	type Tool
} from "../index.ts";
import { createWorkflow } from "$lib/server/db/queries/workflows";
import { createVersion } from "$lib/server/db/queries/versions";
import { writeVersion } from "$lib/server/workflows-store";
import type { TriggerType } from "$lib/server/db/types";

export interface GenerateWorkflowOptions {
	name: string;
	prompt: string;
	triggerType: TriggerType;
	cronExpr?: string | null;
	model?: string;
	onEvent?: (e: AgentEvent) => void;
}

export interface GenerateWorkflowResult {
	workflowId: string;
	versionId: string;
	sourceTs: string;
	transcript: AgentEvent[];
	stopReason: AgentRunResult["stopReason"];
}

interface EmittedPayload {
	sourceTs: string;
	summary: string;
}

const GEN_SYSTEM_PROMPT = `You are Runely's workflow generator. You turn a user's natural-language description into a single TypeScript module that implements their workflow.

## Contract
The module MUST:
- Export a default async function with signature: \`async function run(event: unknown, ctx: Ctx): Promise<unknown>\`
- Be self-contained: no imports from node_modules, no relative imports. All capabilities come from \`ctx\`.
- Be fail-fast: on unrecoverable error, throw. On recoverable error that should halt the workflow, throw with a clear message.

## Ctx surface (all you have)
- \`ctx.workflow: { id: string; name: string }\`
- \`ctx.event: { id: string; triggerType: "webhook"|"cron"|"manual"|"replay"; receivedAt: number }\`
- \`ctx.http.fetch(input, init?) => Promise<Response>\`
- \`ctx.http.get(url, init?) => Promise<Response>\`
- \`ctx.http.post(url, body?, init?) => Promise<Response>\`   // auto-JSON-stringifies plain objects
- \`ctx.log(level, message, data?) => void\`   // level: "debug"|"info"|"warn"|"error"
- \`ctx.state.get<T>(key) => Promise<T | undefined>\`
- \`ctx.state.set(key, value) => Promise<void>\`   // value must be JSON-serializable
- \`ctx.secret(name: string) => string\`   // reads from env; throws if missing

## Event shape
\`event\` is the parsed body of the incoming webhook, or \`{firedAt: number}\` for cron, or whatever the caller passed for manual/replay. It is typed \`unknown\` — validate it inside \`run\` and throw on shape mismatch.

## Style
- Keep it small. Idiomatic TS. Named helper functions are fine.
- Use \`ctx.log\` at key decision points so failures are diagnosable.
- Use \`ctx.state\` for any cross-run memory.
- Use \`ctx.secret("NAME")\` for API keys, not hardcoded strings.
- No console.log. No try/catch around the whole function — let errors propagate.

## Delivery
You must call the \`emit_workflow\` tool EXACTLY ONCE with the full module source plus a one-sentence summary. Do NOT write files via bash or any other tool — emit_workflow is the only way to deliver.`;

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
			error: "source must contain a default export (missing `export default`)"
		};
	}
	if (!EXPORT_DEFAULT_RE.test(source)) {
		return {
			ok: false,
			error:
				"default export must be an async function or arrow function. Expected `export default async function run(event, ctx) { ... }` or `export default async (event, ctx) => { ... }`"
		};
	}
	if (!TWO_ARG_RE.test(source)) {
		return {
			ok: false,
			error:
				"default export must accept two parameters (event, ctx). Got a signature with fewer parameters."
		};
	}
	return { ok: true };
}

function buildUserMessage(opts: GenerateWorkflowOptions): string {
	const trigger = formatTrigger(opts.triggerType, opts.cronExpr ?? null);
	return [
		`Workflow name: ${opts.name}`,
		`Trigger: ${trigger}`,
		"",
		"User prompt:",
		opts.prompt
	].join("\n");
}

function formatTrigger(triggerType: TriggerType, cronExpr: string | null): string {
	if (triggerType === "webhook") return "webhook";
	if (triggerType === "cron") {
		return cronExpr ? `cron (${cronExpr})` : "cron";
	}
	return cronExpr ? `both — webhook and cron (${cronExpr})` : "both — webhook and cron";
}

class EmitSuccess {
	constructor(public readonly payload: EmittedPayload) {}
}

function makeEmitTool(
	state: { attempts: number; emitted: EmittedPayload | null },
	maxAttempts: number
): Tool {
	return {
		name: "emit_workflow",
		description:
			"Deliver the generated workflow. Call this EXACTLY ONCE with the full TypeScript module source and a one-sentence summary. This is the only way to finish the task.",
		inputSchema: {
			type: "object",
			properties: {
				source_ts: {
					type: "string",
					description:
						"Full TypeScript source of the workflow module. Must export a default async function `run(event, ctx)`."
				},
				summary: {
					type: "string",
					description: "One-sentence summary of what the workflow does."
				}
			},
			required: ["source_ts", "summary"],
			additionalProperties: false
		},
		async run(input: unknown): Promise<string> {
			if (input === null || typeof input !== "object") {
				throw new Error("emit_workflow: expected an object input");
			}
			const obj = input as Record<string, unknown>;
			const source = obj.source_ts;
			const summary = obj.summary;
			if (typeof source !== "string") {
				throw new Error("emit_workflow: `source_ts` must be a string");
			}
			if (typeof summary !== "string") {
				throw new Error("emit_workflow: `summary` must be a string");
			}
			state.attempts += 1;
			const validation = validateSource(source);
			if (!validation.ok) {
				if (state.attempts >= maxAttempts) {
					throw new Error(
						`${validation.error}. Max emit attempts (${maxAttempts}) exhausted.`
					);
				}
				throw new Error(
					`${validation.error}. Fix the source and call emit_workflow again.`
				);
			}
			state.emitted = { sourceTs: source, summary };
			// Signal the loop to stop by throwing a sentinel the outer abort handler
			// catches. But tools can't stop the loop directly — instead we rely on the
			// assistant getting a success response and then issuing end_turn. Return
			// a success message telling it the task is complete.
			throw new EmitSuccess(state.emitted);
		}
	};
}

export async function generateWorkflow(
	opts: GenerateWorkflowOptions
): Promise<GenerateWorkflowResult> {
	const maxEmitAttempts = 2;
	const emitState: { attempts: number; emitted: EmittedPayload | null } = {
		attempts: 0,
		emitted: null
	};

	const controller = new AbortController();

	// Wrap the emit tool so that on a successful emit, we capture the payload
	// and abort the agent loop to return promptly.
	const rawEmitTool = makeEmitTool(emitState, maxEmitAttempts);
	const emitTool: Tool = {
		...rawEmitTool,
		async run(input, ctx) {
			try {
				return await rawEmitTool.run(input, ctx);
			} catch (err) {
				if (err instanceof EmitSuccess) {
					controller.abort();
					return `ok: workflow received (${err.payload.summary})`;
				}
				throw err;
			}
		}
	};

	const userMessage = buildUserMessage(opts);

	const result = await runAgent({
		model: opts.model ?? DEFAULT_MODEL,
		systemPrompt: GEN_SYSTEM_PROMPT,
		userMessage,
		tools: [emitTool],
		onEvent: opts.onEvent,
		abortSignal: controller.signal
	});

	if (!emitState.emitted) {
		throw new Error(
			`Agent did not emit a workflow (stopReason=${result.stopReason}). ` +
				`Last message: ${result.finalMessage.slice(0, 500)}`
		);
	}

	const sourceTs = emitState.emitted.sourceTs;

	const workflow = createWorkflow({
		name: opts.name,
		prompt: opts.prompt,
		triggerType: opts.triggerType,
		cronExpr: opts.cronExpr ?? null
	});

	const deployPath = await writeVersion(workflow.id, 1, sourceTs);

	const version = createVersion({
		workflowId: workflow.id,
		sourceTs,
		deployPath,
		createdBy: "user",
		setAsCurrent: true
	});

	return {
		workflowId: workflow.id,
		versionId: version.id,
		sourceTs,
		transcript: result.transcript,
		stopReason: result.stopReason
	};
}
