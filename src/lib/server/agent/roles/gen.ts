import {
	type AgentEvent,
	type AgentRunResult,
	DEFAULT_MODEL,
	type Tool,
	runAgent
} from '../index.ts';
import { listSecretNamesForProject } from '$lib/server/db/queries/secrets';
import { getWorkflow } from '$lib/server/db/queries/workflows';
import { createVersion } from '$lib/server/db/queries/versions';
import { writeVersion } from '$lib/server/workflows-store';
import { typecheckWorkflow } from '$lib/server/typecheck/service';
import type { TriggerType } from '$lib/server/db/types';

export interface GenerateWorkflowOptions {
	name: string;
	prompt: string;
	triggerType: TriggerType;
	cronExpr?: string | null;
	model?: string;
	onEvent?: (e: AgentEvent) => void;
	/**
	 * If provided, the workflow row is created with this id instead of a freshly
	 * generated one. Lets the caller (e.g. the UI form action) mint the id
	 * upfront and redirect to /w/[id] before generation completes.
	 */
	workflowIdOverride?: string;
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
- Export a default async function with signature: \`async function run(event: WorkflowEvent, ctx: Ctx): Promise<unknown>\`
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
\`event\` is \`{ body, headers }\`. \`body\` is the parsed request body (JSON object, form fields, plain text, or null). \`headers\` is a lowercased map of HTTP headers — auth/signature headers are redacted to \`"<redacted>"\` and Cloudflare/proxy noise headers are stripped, but discriminator headers like \`x-github-event\` or \`x-shopify-topic\` are preserved.

The exact \`WorkflowEvent\` type is provided ambient and inferred from this workflow's historical webhook payloads. It's a discriminated union when multiple event shapes have been seen — narrow on a literal field (e.g. \`event.headers["x-github-event"]\` or a body-side discriminator) to access shape-specific fields. The type's definition is shown in the user message; trust it as the source of truth for what fields exist.

## Style
- Keep it small. Idiomatic TS. Named helper functions are fine.
- Use \`ctx.log\` at key decision points so failures are diagnosable.
- Use \`ctx.state\` for any cross-run memory.
- Use \`ctx.secret("NAME")\` for API keys, not hardcoded strings.
- Lean on the inferred type for narrowing instead of adding defensive runtime guards for fields the type already guarantees.
- No console.log. No try/catch around the whole function — let errors propagate.

## Delivery
You must call the \`emit_workflow\` tool EXACTLY ONCE with the full module source plus a one-sentence summary. Do NOT write files via bash or any other tool — emit_workflow is the only way to deliver.

The emitted source is type-checked against the Ctx interface and the inferred WorkflowEvent type before it's accepted. The \`ctx.secret\` parameter is narrowed to the project's actual secret names (listed below), so a typo or an unknown name is a TS error. If emit_workflow returns a tool error with TypeScript diagnostics, read them, fix the code, and call emit_workflow again with the corrected source.`;

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
	secretNames: string[],
	workflowEventTypeTs: string | null
): string {
	const trigger = formatTrigger(opts.triggerType, opts.cronExpr ?? null);
	const lines = [
		`Workflow name: ${opts.name}`,
		`Trigger: ${trigger}`,
		'',
		'## WorkflowEvent type (inferred from historical webhook payloads, ambient)',
		'```ts',
		workflowEventTypeTs && workflowEventTypeTs.trim().length > 0
			? workflowEventTypeTs
			: 'type WorkflowEvent = { body: unknown; headers: { [key: string]: string | undefined } };',
		'```',
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
	secretNames: readonly string[],
	workflowEventTypeTs: string | null
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
			const tc = typecheckWorkflow(secretNames, source, workflowEventTypeTs);
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

	// The /new form action pre-inserts the workflow row so /w/[id] can render
	// While generation is pending. The id is passed in via workflowIdOverride.
	if (!opts.workflowIdOverride) {
		throw new Error('generateWorkflow: workflowIdOverride is required (caller must pre-insert)');
	}
	const preWorkflow = await getWorkflow(opts.workflowIdOverride);
	if (!preWorkflow) {
		throw new Error(`generateWorkflow: workflow row not found (id=${opts.workflowIdOverride})`);
	}
	const secretMetas = await listSecretNamesForProject(preWorkflow.projectId);
	const secretNames = secretMetas.map((s) => s.name);
	const workflowEventTypeTs = preWorkflow.inferredEventTypeTs;
	const userMessage = buildUserMessage(opts, secretNames, workflowEventTypeTs);

	// Wrap the emit tool so that on a successful emit, we capture the payload
	// And abort the agent loop to return promptly.
	const rawEmitTool = makeEmitTool(emitState, maxEmitAttempts, secretNames, workflowEventTypeTs);
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
