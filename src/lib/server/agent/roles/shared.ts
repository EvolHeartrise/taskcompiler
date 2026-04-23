import type { Tool } from '../tools.ts';

export function truncate(s: string, max: number): string {
	if (s.length <= max) {
		return s;
	}
	return `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

export class EmitSuccess {
	constructor(public readonly payload: unknown) {}
}

export function wrapTerminal<T>(
	tool: Tool,
	controller: AbortController,
	formatMessage: (payload: T) => string
): Tool {
	return {
		...tool,
		async run(input, ctx) {
			try {
				return await tool.run(input, ctx);
			} catch (error) {
				if (error instanceof EmitSuccess) {
					controller.abort();
					return formatMessage(error.payload as T);
				}
				throw error;
			}
		}
	};
}
