// Extract a human-readable message from any thrown value. Non-Error throws
// fall back to String() so catch blocks never leak `[object Object]` into
// logs or user-facing errors.
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// Trim a string to `max` characters, appending a marker that records how
// many chars were dropped. Shared across upload error bodies, AI Gateway
// response previews, and agent payload previews so all truncation looks the
// same in logs.
export function truncate(s: string, max: number): string {
	if (s.length <= max) {
		return s;
	}
	return `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

// JSON.parse for nullable strings (DB columns that may be NULL). Returns
// null when the input is null; otherwise asserts the parsed value matches T.
// Trusts the input — propagates SyntaxError if the stored data is corrupt.
export function parseJson<T>(s: string | null): T | null {
	if (s === null) {
		return null;
	}
	return JSON.parse(s) as T;
}

// JSON.parse for non-null strings, with an optional label that gets prepended
// to any SyntaxError. Use for required JSON columns we wrote ourselves; the
// label makes it clear which field is corrupt when something goes wrong.
export function parseJsonOrThrow<T>(s: string, label?: string): T {
	try {
		return JSON.parse(s) as T;
	} catch (err) {
		const prefix = label ? `${label}: ` : '';
		throw new Error(`${prefix}invalid JSON: ${errorMessage(err)}`, { cause: err });
	}
}
