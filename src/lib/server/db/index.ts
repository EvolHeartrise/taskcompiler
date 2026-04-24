import { env } from 'cloudflare:workers';

export function getDb() {
	return env.DB;
}

export function uuid(): string {
	return crypto.randomUUID();
}

export function now(): number {
	return Date.now();
}
