import { type AgentEvent, type AgentRunResult, DEFAULT_MODEL, runAgent } from '../loop.ts';
import type { Tool } from '../tools.ts';
import { listSecretNamesForProject } from '$lib/server/db/queries/secrets';
import { getWorkflow } from '$lib/server/db/queries/workflows';
import { getEventSource } from '$lib/server/db/queries/event-sources';
import { createVersion } from '$lib/server/db/queries/versions';
import { writeVersion } from '$lib/server/workflows-store';
import { typecheckWorkflow } from '../typecheck/service';
import type { TriggerType } from '$lib/server/db/types';

export interface GenerateWorkflowOptions {
	name: string;
	prompt: string;
	model?: string;
	onEvent?: (e: AgentEvent) => void;
	/**
	 * The workflow row must exist before generation starts (the /new form
	 * action pre-inserts it so /w/[id] can render while gen is pending).
	 * Pass the id here — the row's event_source_id is used to describe the
	 * trigger in the user message.
	 */
	workflowIdOverride: string;
}

export interface GenerateWorkflowResult {
	workflowId: string;
	versionId: string;
	sourceTs: string;
	transcript: AgentEvent[];
	stopReason: AgentRunResult['stopReason'];
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
\`event\` is \`{ body, headers }\` at runtime, but typed \`unknown\` — validate it inside \`run\` and throw on shape mismatch.
- \`body\` is the parsed request body (JSON object, form fields, plain text, or null) for webhooks; \`{firedAt: number}\` for cron; or whatever the caller passed for manual/replay.
- \`headers\` is a lowercased map of HTTP headers (Record<string, string>). Auth and signature headers are redacted to \`"<redacted>"\` and Cloudflare/proxy noise headers are stripped, but discriminator headers like \`x-github-event\` or \`x-shopify-topic\` are preserved. Cron/manual/replay events have \`headers: {}\`.

A typical first step is something like:
\`\`\`ts
const { body, headers } = event as { body: unknown; headers: Record<string, string> };
\`\`\`

## Style
- Keep it small. Idiomatic TS. Named helper functions are fine.
- Use \`ctx.log\` at key decision points so failures are diagnosable.
- Use \`ctx.state\` for any cross-run memory.
- Use \`ctx.secret("NAME")\` for API keys, not hardcoded strings.
- No console.log. No try/catch around the whole function — let errors propagate.

## Delivery
You must call the \`emit_workflow\` tool EXACTLY ONCE with the full module source plus a one-sentence summary. Do NOT write files via bash or any other tool — emit_workflow is the only way to deliver.

The emitted source is type-checked against the Ctx interface before it's accepted. The \`ctx.secret\` parameter is narrowed to the project's actual secret names (listed below), so a typo or an unknown name is a TS error. If emit_workflow returns a tool error with TypeScript diagnostics, read them, fix the code, and call emit_workflow again with the corrected source.`;

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

function buildUserMessage(
	opts: GenerateWorkflowOptions,
	triggerType: TriggerType,
	cronExpr: string | null,
	secretNames: string[]
): string {
	const trigger = formatTrigger(triggerType, cronExpr);
	const lines = [
		`Workflow name: ${opts.name}`,
		`Trigger: ${trigger}`,
		'',
		'## Available secrets (via ctx.secret)',
		secretNames.length === 0
			? '(none yet — if the workflow needs one, use `ctx.secret("NAME")` anyway and the user will add it before the workflow runs)'
			: secretNames.map((n) => `- ${n}`).join('\n'),
		'',
		'User prompt:',
		opts.prompt
	];
	return lines.join('\n');
}

function formatTrigger(triggerType: TriggerType, cronExpr: string | null): string {
	if (triggerType === 'cron') {
		return cronExpr ? `cron (${cronExpr})` : 'cron';
	}
	return 'webhook';
}

class EmitSuccess {
	constructor(public readonly payload: EmittedPayload) {}
}

function makeEmitTool(
	state: { attempts: number; emitted: EmittedPayload | null },
	maxAttempts: number,
	secretNames: readonly string[]
): Tool {
	return {
		description:
			'Deliver the generated workflow. Call this EXACTLY ONCE with the full TypeScript module source and a one-sentence summary. This is the only way to finish the task.',
		inputSchema: {
			additionalProperties: false,
			properties: {
				source_ts: {
					description:
						'Full TypeScript source of the workflow module. Must export a default async function `run(event, ctx)`.',
					type: 'string'
				},
				summary: {
					description: 'One-sentence summary of what the workflow does.',
					type: 'string'
				}
			},
			required: ['source_ts', 'summary'],
			type: 'object'
		},
		name: 'emit_workflow',
		async run(input: unknown): Promise<string> {
			if (input === null || typeof input !== 'object') {
				throw new Error('emit_workflow: expected an object input');
			}
			const obj = input as Record<string, unknown>;
			const source = obj.source_ts;
			const { summary } = obj;
			if (typeof source !== 'string') {
				throw new TypeError('emit_workflow: `source_ts` must be a string');
			}
			if (typeof summary !== 'string') {
				throw new TypeError('emit_workflow: `summary` must be a string');
			}
			state.attempts += 1;
			const validation = validateSource(source);
			if (!validation.ok) {
				if (state.attempts >= maxAttempts) {
					throw new Error(`${validation.error}. Max emit attempts (${maxAttempts}) exhausted.`);
				}
				throw new Error(`${validation.error}. Fix the source and call emit_workflow again.`);
			}
			const tc = typecheckWorkflow(secretNames, source);
			if (!tc.ok) {
				const details = tc.diagnostics.join('\n');
				if (state.attempts >= maxAttempts) {
					throw new Error(
						`TypeScript errors in emitted source (max emit attempts (${maxAttempts}) exhausted):\n${details}`
					);
				}
				throw new Error(
					`TypeScript errors in emitted source. Fix them and call emit_workflow again:\n${details}`
				);
			}
			state.emitted = { sourceTs: source, summary };
			// Signal the loop to stop by throwing a sentinel the outer abort handler
			// Catches. But tools can't stop the loop directly — instead we rely on the
			// Assistant getting a success response and then issuing end_turn. Return
			// A success message telling it the task is complete.
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

	const preWorkflow = await getWorkflow(opts.workflowIdOverride);
	if (!preWorkflow) {
		throw new Error(`generateWorkflow: workflow row not found (id=${opts.workflowIdOverride})`);
	}
	const source = await getEventSource(preWorkflow.eventSourceId);
	if (!source) {
		throw new Error(`generateWorkflow: event source not found (id=${preWorkflow.eventSourceId})`);
	}
	const secretMetas = await listSecretNamesForProject(preWorkflow.projectId);
	const secretNames = secretMetas.map((s) => s.name);
	const userMessage = buildUserMessage(opts, source.triggerType, source.cronExpr, secretNames);

	// Wrap the emit tool so that on a successful emit, we capture the payload
	// And abort the agent loop to return promptly.
	const rawEmitTool = makeEmitTool(emitState, maxEmitAttempts, secretNames);
	const emitTool: Tool = {
		...rawEmitTool,
		async run(input, ctx) {
			try {
				return await rawEmitTool.run(input, ctx);
			} catch (error) {
				if (error instanceof EmitSuccess) {
					controller.abort();
					return `ok: workflow received (${error.payload.summary})`;
				}
				throw error;
			}
		}
	};

	const result = await runAgent({
		abortSignal: controller.signal,
		model: opts.model ?? DEFAULT_MODEL,
		onEvent: opts.onEvent,
		systemPrompt: GEN_SYSTEM_PROMPT,
		tools: [emitTool],
		userMessage
	});

	if (!emitState.emitted) {
		const errorEvents = result.transcript
			.filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error')
			.map((e) => e.error);
		const errorDetail =
			errorEvents.length > 0 ? ` Errors: ${errorEvents.join(' | ').slice(0, 800)}` : '';
		throw new Error(
			`Agent did not emit a workflow (stopReason=${result.stopReason}). ` +
				`Last message: ${result.finalMessage.slice(0, 500)}${errorDetail}`
		);
	}

	const { sourceTs } = emitState.emitted;
	const workflow = preWorkflow;

	const deployPath = await writeVersion(workflow.id, 1, sourceTs);

	const version = await createVersion({
		createdBy: 'user',
		deployPath,
		setAsCurrent: true,
		sourceTs,
		workflowId: workflow.id
	});

	return {
		sourceTs,
		stopReason: result.stopReason,
		transcript: result.transcript,
		versionId: version.id,
		workflowId: workflow.id
	};
}
