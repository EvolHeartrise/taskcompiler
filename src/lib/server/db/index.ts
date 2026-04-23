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
