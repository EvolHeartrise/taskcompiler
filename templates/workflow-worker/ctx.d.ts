// Agent-visible workflow execution context. This file is type-checked against
// The generated workflow module before deploy; the `secret` parameter type is
// Substituted per project with a string-literal union of that project's actual
// Secret names (or `never` when the project has no secrets yet), so a typo in
// `ctx.secret("…")` becomes a TS error that the agent must fix.
//
// Kept in sync with the runtime ctx surface in templates/workflow-worker/ctx.ts.
// The `__RUNELY_SECRET_NAMES__` marker is the ONLY hook the typecheck service
// Rewrites — do not remove it.

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
	secret: (name: /* __RUNELY_SECRET_NAMES__ */ never) => string;
}
