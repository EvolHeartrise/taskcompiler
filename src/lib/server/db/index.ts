export function getDb(env: Env) {
	return env.DB;
}

export function uuid(): string {
	return crypto.randomUUID();
}

export function now(): number {
	return Date.now();
}
