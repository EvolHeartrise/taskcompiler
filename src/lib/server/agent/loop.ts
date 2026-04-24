import { errorMessage } from '$lib/server/util';
import {
	createMessage,
	type AgentMessage,
	type AgentTool,
	type ContentBlock,
	type ToolResultBlock
} from './ai-gateway.ts';
import { runToolCall, toolToAgentDefinition, type Tool, type ToolCtx } from './tools.ts';

export const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.6';
const DEFAULT_MAX_TOKENS = 4096;

export type AgentEvent =
	| { type: 'assistant_message'; content: string }
	| { type: 'tool_call'; id: string; name: string; args: unknown }
	| { type: 'tool_result'; id: string; ok: boolean; output: string }
	| { type: 'error'; error: string };

export interface AgentRunOptions {
	model?: string;
	systemPrompt: string;
	userMessage: string;
	tools: Tool[];
	maxTurns?: number;
	onEvent?: (e: AgentEvent) => void;
	abortSignal?: AbortSignal;
}

export type StopReason = 'end_turn' | 'max_turns' | 'tool_error' | 'aborted';

export interface AgentRunResult {
	finalMessage: string;
	transcript: AgentEvent[];
	stopReason: StopReason;
	turns: number;
}

function extractText(content: ContentBlock[]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === 'text') {
			parts.push(block.text);
		}
	}
	return parts.join('');
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
	const model = opts.model ?? DEFAULT_MODEL;
	const maxTurns = opts.maxTurns ?? 40;
	const transcript: AgentEvent[] = [];

	const emit = (e: AgentEvent) => {
		transcript.push(e);
		opts.onEvent?.(e);
	};

	const toolsByName = new Map<string, Tool>();
	for (const t of opts.tools) {
		toolsByName.set(t.name, t);
	}
	const toolDefs: AgentTool[] | undefined =
		opts.tools.length > 0 ? opts.tools.map(toolToAgentDefinition) : undefined;

	const ctx: ToolCtx = {
		abortSignal: opts.abortSignal,
		log: () => {}
	};

	const messages: AgentMessage[] = [{ role: 'user', content: opts.userMessage }];

	let finalMessage = '';
	let stopReason: StopReason = 'max_turns';
	let turns = 0;

	for (let turn = 0; turn < maxTurns; turn++) {
		turns = turn + 1;

		if (opts.abortSignal?.aborted) {
			stopReason = 'aborted';
			break;
		}

		let response;
		try {
			response = await createMessage(
				{
					model,
					max_tokens: DEFAULT_MAX_TOKENS,
					system: opts.systemPrompt,
					messages,
					tools: toolDefs
				},
				{ signal: opts.abortSignal }
			);
		} catch (err) {
			if (opts.abortSignal?.aborted) {
				stopReason = 'aborted';
				break;
			}
			emit({ type: 'error', error: errorMessage(err) });
			stopReason = 'tool_error';
			break;
		}

		const assistantBlocks = response.content;
		messages.push({ role: 'assistant', content: assistantBlocks });

		const assistantText = extractText(assistantBlocks);
		if (assistantText.length > 0) {
			emit({ type: 'assistant_message', content: assistantText });
			finalMessage = assistantText;
		}

		const toolUses = assistantBlocks.filter(
			(b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
		);

		if (toolUses.length === 0) {
			stopReason = 'end_turn';
			break;
		}

		const toolResultBlocks: ToolResultBlock[] = [];
		let aborted = false;

		for (const call of toolUses) {
			if (opts.abortSignal?.aborted) {
				aborted = true;
				break;
			}
			const name = call.name;
			const input = call.input;
			emit({ type: 'tool_call', id: call.id, name, args: input });

			const tool = toolsByName.get(name);
			if (!tool) {
				const errText = `Unknown tool: ${name}`;
				toolResultBlocks.push({
					type: 'tool_result',
					tool_use_id: call.id,
					content: errText,
					is_error: true
				});
				emit({ type: 'tool_result', id: call.id, ok: false, output: errText });
				continue;
			}

			const argsJson = JSON.stringify(input ?? {});
			const result = await runToolCall(tool, argsJson, ctx);
			if (result.ok) {
				const output = result.output.length > 0 ? result.output : '(no output)';
				toolResultBlocks.push({
					type: 'tool_result',
					tool_use_id: call.id,
					content: output
				});
				emit({
					type: 'tool_result',
					id: call.id,
					ok: true,
					output: result.output
				});
			} else {
				toolResultBlocks.push({
					type: 'tool_result',
					tool_use_id: call.id,
					content: result.error,
					is_error: true
				});
				emit({
					type: 'tool_result',
					id: call.id,
					ok: false,
					output: result.error
				});
			}
		}

		if (toolResultBlocks.length > 0) {
			messages.push({ role: 'user', content: toolResultBlocks });
		}

		if (aborted || opts.abortSignal?.aborted) {
			stopReason = 'aborted';
			break;
		}
	}

	return { finalMessage, transcript, stopReason, turns };
}
