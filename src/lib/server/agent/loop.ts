import {
	chatCompletion,
	type OpenRouterMessage,
	type OpenRouterToolCall
} from "./openrouter.ts";
import {
	runToolCall,
	toolToOpenRouterDefinition,
	type Tool,
	type ToolCtx
} from "./tools.ts";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

export type AgentEvent =
	| { type: "assistant_message"; content: string }
	| { type: "tool_call"; id: string; name: string; args: unknown }
	| { type: "tool_result"; id: string; ok: boolean; output: string }
	| { type: "error"; error: string };

export interface AgentRunOptions {
	model?: string;
	systemPrompt: string;
	userMessage: string;
	tools: Tool[];
	maxTurns?: number;
	onEvent?: (e: AgentEvent) => void;
	workingDir?: string;
	abortSignal?: AbortSignal;
}

export type StopReason = "end_turn" | "max_turns" | "tool_error" | "aborted";

export interface AgentRunResult {
	finalMessage: string;
	transcript: AgentEvent[];
	stopReason: StopReason;
	turns: number;
}

function tryParseJson(s: string): unknown {
	if (s.trim().length === 0) return {};
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
	const model = opts.model ?? DEFAULT_MODEL;
	const maxTurns = opts.maxTurns ?? 40;
	const workingDir = opts.workingDir ?? process.cwd();
	const transcript: AgentEvent[] = [];

	const emit = (e: AgentEvent) => {
		transcript.push(e);
		opts.onEvent?.(e);
	};

	const toolsByName = new Map<string, Tool>();
	for (const t of opts.tools) toolsByName.set(t.name, t);
	const toolDefs =
		opts.tools.length > 0
			? opts.tools.map(toolToOpenRouterDefinition)
			: undefined;

	const ctx: ToolCtx = {
		workingDir,
		abortSignal: opts.abortSignal,
		log: () => {
			// no-op by default; callers wire logging via onEvent
		}
	};

	const messages: OpenRouterMessage[] = [
		{ role: "system", content: opts.systemPrompt },
		{ role: "user", content: opts.userMessage }
	];

	let finalMessage = "";
	let stopReason: StopReason = "max_turns";
	let turns = 0;

	for (let turn = 0; turn < maxTurns; turn++) {
		turns = turn + 1;

		if (opts.abortSignal?.aborted) {
			stopReason = "aborted";
			break;
		}

		let response;
		try {
			response = await chatCompletion({
				model,
				messages,
				tools: toolDefs,
				signal: opts.abortSignal
			});
		} catch (err) {
			if (opts.abortSignal?.aborted) {
				stopReason = "aborted";
				break;
			}
			const msg = err instanceof Error ? err.message : String(err);
			emit({ type: "error", error: msg });
			stopReason = "tool_error";
			break;
		}

		const choice = response.choices[0];
		if (!choice) {
			emit({ type: "error", error: "OpenRouter returned no choices" });
			stopReason = "tool_error";
			break;
		}

		const assistantMsg = choice.message;
		const content = assistantMsg.content ?? "";
		const toolCalls: OpenRouterToolCall[] = assistantMsg.tool_calls ?? [];

		messages.push({
			role: "assistant",
			content: content.length > 0 ? content : null,
			tool_calls: toolCalls.length > 0 ? toolCalls : undefined
		});

		if (content.length > 0) {
			emit({ type: "assistant_message", content });
			finalMessage = content;
		}

		if (toolCalls.length === 0) {
			stopReason = "end_turn";
			break;
		}

		for (const call of toolCalls) {
			if (opts.abortSignal?.aborted) {
				stopReason = "aborted";
				break;
			}
			const name = call.function.name;
			const argsJson = call.function.arguments ?? "";
			const parsedArgs = tryParseJson(argsJson);
			emit({ type: "tool_call", id: call.id, name, args: parsedArgs });

			const tool = toolsByName.get(name);
			if (!tool) {
				const errText = `Unknown tool: ${name}`;
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					name,
					content: JSON.stringify({ ok: false, error: errText })
				});
				emit({ type: "tool_result", id: call.id, ok: false, output: errText });
				continue;
			}

			const result = await runToolCall(tool, argsJson, ctx);
			if (result.ok) {
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					name,
					content: result.output.length > 0 ? result.output : "(no output)"
				});
				emit({
					type: "tool_result",
					id: call.id,
					ok: true,
					output: result.output
				});
			} else {
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					name,
					content: JSON.stringify({ ok: false, error: result.error })
				});
				emit({
					type: "tool_result",
					id: call.id,
					ok: false,
					output: result.error
				});
			}
		}

		if (opts.abortSignal?.aborted) {
			stopReason = "aborted";
			break;
		}
	}

	return { finalMessage, transcript, stopReason, turns };
}
