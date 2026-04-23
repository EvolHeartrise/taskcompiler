import type { AgentTool } from './ai-gateway.ts';

export interface ToolCtx {
	abortSignal?: AbortSignal;
	log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface Tool<Input = unknown, Output = unknown> {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run(input: Input, ctx: ToolCtx): Promise<Output>;
}

export function toolToAgentDefinition(tool: Tool): AgentTool {
	return {
		description: tool.description,
		input_schema: tool.inputSchema,
		name: tool.name
	};
}

export type ToolRunResult = { ok: true; output: string } | { ok: false; error: string };

export async function runToolCall(
	tool: Tool,
	argsJson: string,
	ctx: ToolCtx
): Promise<ToolRunResult> {
	let parsed: unknown;
	try {
		parsed = argsJson.trim().length === 0 ? {} : JSON.parse(argsJson);
	} catch (error) {
		return {
			ok: false,
			error: `Failed to parse tool arguments as JSON: ${errorMessage(error)}`
		};
	}

	try {
		const output = await tool.run(parsed, ctx);
		if (typeof output === 'string') {
			return { ok: true, output };
		}
		if (output === undefined) {
			return { ok: true, output: '' };
		}
		return { ok: true, output: JSON.stringify(output) };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
