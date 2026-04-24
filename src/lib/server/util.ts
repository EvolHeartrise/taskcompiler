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
