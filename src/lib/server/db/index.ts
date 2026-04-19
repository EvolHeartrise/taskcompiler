import { getEnv } from "$lib/server/env";

export function getDb() {
	return getEnv().DB;
}

export function uuid(): string {
	return crypto.randomUUID();
}

export function now(): number {
	return Date.now();
}
