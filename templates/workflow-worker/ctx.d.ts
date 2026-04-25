// Kept in sync with the runtime ctx surface in ctx.ts. The typecheck service
// rewrites the `__TASKCOMPILER_SECRET_NAMES__` marker below with a per-project
// string-literal union (or `never`) so `ctx.secret("TYPO")` becomes a TS
// error — DO NOT remove the marker.

interface Ctx {
	workflow: { id: string; name: string };
	event: {
		id: string;
		triggerType: 'webhook' | 'cron' | 'manual' | 'replay';
		receivedAt: number;
	};
	http: {
		fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
		get: (url: string, init?: RequestInit) => Promise<Response>;
		post: (url: string, body?: unknown, init?: RequestInit) => Promise<Response>;
	};
	log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
	state: {
		get<T = unknown>(key: string): Promise<T | undefined>;
		set(key: string, value: unknown): Promise<void>;
	};
	secret: (name: /* __TASKCOMPILER_SECRET_NAMES__ */ never) => string;
}
