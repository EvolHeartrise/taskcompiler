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

// Convert a snake_case row from D1 to its camelCase domain shape. Pass
// `skip` to exclude columns the caller will layer on top (JSON-decoded or
// boolean-coerced fields); the returned object is cast to the caller's
// Omit<T, ...> type.
export function mapRow<T>(row: object, skip: readonly string[] = []): T {
	const skipSet = new Set(skip);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (skipSet.has(key)) {
			continue;
		}
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
