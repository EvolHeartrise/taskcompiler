import type { Tool } from '../tools.ts';

export const EXPORT_DEFAULT_RE =
	/export\s+default\s+(async\s+function|function\s+\w*\s*\(|(async\s+)?\([^)]*\)\s*=>|(async\s+)?[A-Za-z_$][\w$]*\s*=>)/;

export const TWO_ARG_RE =
	/export\s+default\s+(?:async\s+)?(?:function\s*\w*\s*)?\(\s*[^,)\s]+\s*(?::[^,)]*)?\s*,\s*[^,)\s]+/;

export function validateSource(source: string): { ok: true } | { ok: false; error: string } {
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
