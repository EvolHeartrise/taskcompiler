export interface ErrorShape {
	name: string;
	message: string;
	stack?: string;
}

function safeStringify(v: unknown): string {
	try {
		return typeof v === 'string' ? v : JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export function toErrorShape(err: unknown): ErrorShape {
	if (err instanceof Error) {
		const out: ErrorShape = {
			name: err.name || 'Error',
			message: err.message || String(err)
		};
		if (err.stack) {
			out.stack = err.stack;
		}
		return out;
	}
	if (typeof err === 'object' && err !== null) {
		const anyErr = err as { name?: unknown; message?: unknown; stack?: unknown };
		const out: ErrorShape = {
			name: typeof anyErr.name === 'string' ? anyErr.name : 'NonError',
			message: typeof anyErr.message === 'string' ? anyErr.message : safeStringify(err)
		};
		if (typeof anyErr.stack === 'string') {
			out.stack = anyErr.stack;
		}
		return out;
	}
	return { name: 'NonError', message: safeStringify(err) };
}
