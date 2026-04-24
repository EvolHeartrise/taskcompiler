export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function truncate(s: string, max: number): string {
	if (s.length <= max) {
		return s;
	}
	return `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

// Propagates SyntaxError on corrupt input rather than wrapping it.
export function parseJson<T>(s: string | null): T | null {
	if (s === null) {
		return null;
	}
	return JSON.parse(s) as T;
}

export function parseJsonOrThrow<T>(s: string, label?: string): T {
	try {
		return JSON.parse(s) as T;
	} catch (err) {
		const prefix = label ? `${label}: ` : '';
		throw new Error(`${prefix}invalid JSON: ${errorMessage(err)}`, { cause: err });
	}
}
