import { getEnv } from '$lib/server/env';

export function getDb() {
	return getEnv().DB;
}

export function uuid(): string {
	return crypto.randomUUID();
}

export function now(): number {
	return Date.now();
}

export function parseJson<T>(s: string | null): T | null {
	if (s === null) {
		return null;
	}
	return JSON.parse(s) as T;
}

// Convert a snake_case row from D1 to its camelCase domain shape. Callers
// Cast the return to the target type; tables with JSON fields or boolean
// Coercions keep a hand-written mapper that delegates here for the plain
// Columns and layers the custom fields on top.
export function mapRow<T>(row: object): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		let camel = '';
		let capitalize = false;
		for (const ch of key) {
			if (ch === '_') {
				capitalize = true;
			} else if (capitalize) {
				camel += ch.toUpperCase();
				capitalize = false;
			} else {
				camel += ch;
			}
		}
		out[camel] = value;
	}
	return out as T;
}
