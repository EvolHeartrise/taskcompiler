import { type AgentEvent, type AgentRunResult, DEFAULT_MODEL, runAgent } from '../loop.ts';
import { listSecretNamesForProject } from '$lib/server/db/queries/secrets';
import { getWorkflow } from '$lib/server/db/queries/workflows';
import { getEventSource } from '$lib/server/db/queries/event-sources';
import { createVersion } from '$lib/server/db/queries/versions';
import { writeVersion } from '$lib/server/workflows-store';
import { makeTypecheckedEmitTool, wrapTerminal } from './shared.ts';
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
	workflowId: string;
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

export async function generateWorkflow(
	opts: GenerateWorkflowOptions
): Promise<GenerateWorkflowResult> {
	const maxEmitAttempts = 2;
	const emitState: { attempts: number; emitted: EmittedPayload | null } = {
		attempts: 0,
		emitted: null
	};

	const controller = new AbortController();

	const preWorkflow = await getWorkflow(opts.workflowId);
	if (!preWorkflow) {
		throw new Error(`generateWorkflow: workflow row not found (id=${opts.workflowId})`);
	}
	const source = await getEventSource(preWorkflow.eventSourceId);
	if (!source) {
		throw new Error(`generateWorkflow: event source not found (id=${preWorkflow.eventSourceId})`);
	}
	const secretMetas = await listSecretNamesForProject(preWorkflow.projectId);
	const secretNames = secretMetas.map((s) => s.name);
	const userMessage = buildUserMessage(opts, source.triggerType, source.cronExpr, secretNames);

	const emitTool = wrapTerminal<EmittedPayload>(
		makeTypecheckedEmitTool<EmittedPayload>({
			name: 'emit_workflow',
			description:
				'Deliver the generated workflow. Call this EXACTLY ONCE with the full TypeScript module source and a one-sentence summary. This is the only way to finish the task.',
			secretNames,
			maxAttempts: maxEmitAttempts,
			state: emitState,
			buildPayload: ({ sourceTs, summary }) => ({ sourceTs, summary })
		}),
		controller,
		(payload) => `ok: workflow received (${payload.summary})`
	);

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
