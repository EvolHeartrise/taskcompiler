import type { RunError } from '$lib/server/db/types';

function safeStringify(v: unknown): string {
	try {
		return typeof v === 'string' ? v : JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export function toRunError(err: unknown): RunError {
	if (err instanceof Error) {
		const out: RunError = {
			message: err.message || String(err),
			name: err.name || 'Error'
		};
		if (err.stack) {
			out.stack = err.stack;
		}
		return out;
	}
	if (typeof err === 'object' && err !== null) {
		const anyErr = err as { name?: unknown; message?: unknown; stack?: unknown };
		const out: RunError = {
			message: typeof anyErr.message === 'string' ? anyErr.message : safeStringify(err),
			name: typeof anyErr.name === 'string' ? anyErr.name : 'NonError'
		};
		if (typeof anyErr.stack === 'string') {
			out.stack = anyErr.stack;
		}
		return out;
	}
	return { message: safeStringify(err), name: 'NonError' };
}

export function classifyInfraFailure(name: string, message: string): RunError {
	return { category: 'infra', message, name };
}
