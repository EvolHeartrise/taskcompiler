import type { Tool } from '../tools.ts';

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
