interface D1StateRow {
	value_json: string;
}

interface D1SecretRow {
	name: string;
	value: string;
}

interface D1PreparedStatement {
	bind: (...values: unknown[]) => D1PreparedStatement;
	first: <T = unknown>() => Promise<T | null>;
	run: () => Promise<unknown>;
	all: <T = unknown>() => Promise<{ results: T[] }>;
}

interface D1Database {
	prepare: (query: string) => D1PreparedStatement;
}

export interface WorkflowEnv {
	DB: D1Database;
	PROJECT_ID: string;
	[key: string]: unknown;
}

interface InvokePayload {
	workflow: { id: string; name: string };
	event: {
		id: string;
		triggerType: 'webhook' | 'cron' | 'manual' | 'replay';
		receivedAt: number;
		payload: unknown;
		headers: Record<string, string>;
	};
}

interface LogEntry {
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	ts: number;
	data?: unknown;
}

export interface Ctx {
	workflow: { id: string; name: string };
	event: { id: string; triggerType: string; receivedAt: number };
	http: {
		fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
		get: (url: string, init?: RequestInit) => Promise<Response>;
		post: (url: string, body?: unknown, init?: RequestInit) => Promise<Response>;
	};
	log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
	state: {
		get: <T = unknown>(key: string) => Promise<T | undefined>;
		set: (key: string, value: unknown) => Promise<void>;
	};
	secret: (name: string) => string;
}

function isBodyLike(value: unknown): boolean {
	if (typeof value === 'string') {
		return true;
	}
	if (value instanceof ArrayBuffer) {
		return true;
	}
	if (ArrayBuffer.isView(value)) {
		return true;
	}
	if (typeof FormData !== 'undefined' && value instanceof FormData) {
		return true;
	}
	if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
		return true;
	}
	if (typeof Blob !== 'undefined' && value instanceof Blob) {
		return true;
	}
	if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) {
		return true;
	}
	return false;
}

function headerHas(init: RequestInit | undefined, name: string): boolean {
	const h = init?.headers;
	if (!h) {
		return false;
	}
	const needle = name.toLowerCase();
	if (h instanceof Headers) {
		return h.has(name);
	}
	if (Array.isArray(h)) {
		return h.some(([k]) => k.toLowerCase() === needle);
	}
	return Object.keys(h as Record<string, string>).some((k) => k.toLowerCase() === needle);
}

/**
 * Pull the project's secrets fresh per invocation. One D1 query per
 * workflow execution; `ctx.secret()` reads from the returned Map.
 * Rotating a secret in the UI takes effect on the very next invocation —
 * no redeploy needed.
 */
export async function loadSecrets(env: WorkflowEnv): Promise<Map<string, string>> {
	const res = await env.DB.prepare(`SELECT name, value FROM project_secrets WHERE project_id = ?`)
		.bind(env.PROJECT_ID)
		.all<D1SecretRow>();
	const map = new Map<string, string>();
	for (const row of res.results) {
		map.set(row.name, row.value);
	}
	return map;
}

export function buildCtx(
	env: WorkflowEnv,
	body: InvokePayload,
	logs: LogEntry[],
	secrets: Map<string, string>
): Ctx {
	const workflowId = body.workflow.id;

	const log: Ctx['log'] = (level, message, data) => {
		const entry: LogEntry = { level, message, ts: Date.now() };
		if (data !== undefined) {
			entry.data = data;
		}
		logs.push(entry);
	};

	const instrumentedFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
		const method = (init?.method ?? 'GET').toUpperCase();
		const url = typeof input === 'string' ? input : input.toString();
		const started = Date.now();
		try {
			const res = await fetch(input, init);
			logs.push({
				data: { method, ms: Date.now() - started, status: res.status, url },
				level: 'info',
				message: 'http',
				ts: Date.now()
			});
			return res;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logs.push({
				data: { error: message, method, ms: Date.now() - started, url },
				level: 'error',
				message: 'http',
				ts: Date.now()
			});
			throw error;
		}
	};

	const httpGet = (url: string, init?: RequestInit): Promise<Response> =>
		instrumentedFetch(url, { ...init, method: 'GET' });

	const httpPost = (url: string, payload?: unknown, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		let bodyInit: BodyInit | undefined;
		if (payload === undefined || payload === null) {
			bodyInit = undefined;
		} else if (isBodyLike(payload)) {
			bodyInit = payload as BodyInit;
		} else {
			bodyInit = JSON.stringify(payload);
			if (!headerHas(init, 'content-type')) {
				headers.set('Content-Type', 'application/json');
			}
		}
		return instrumentedFetch(url, {
			...init,
			body: bodyInit,
			headers,
			method: 'POST'
		});
	};

	const stateGet = async <T = unknown>(key: string): Promise<T | undefined> => {
		const row = await env.DB.prepare(
			`SELECT value_json FROM workflow_state WHERE workflow_id = ? AND key = ?`
		)
			.bind(workflowId, key)
			.first<D1StateRow>();
		if (!row) {
			return undefined;
		}
		return JSON.parse(row.value_json) as T;
	};

	const stateSet = async (key: string, value: unknown): Promise<void> => {
		await env.DB.prepare(
			`INSERT INTO workflow_state (workflow_id, key, value_json, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(workflow_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
		)
			.bind(workflowId, key, JSON.stringify(value ?? null), Date.now())
			.run();
	};

	return {
		event: {
			id: body.event.id,
			receivedAt: body.event.receivedAt,
			triggerType: body.event.triggerType
		},
		http: {
			fetch: instrumentedFetch,
			get: httpGet,
			post: httpPost
		},
		log,
		secret: (name: string): string => {
			const v = secrets.get(name);
			if (typeof v !== 'string' || v === '') {
				throw new Error(`Secret not set: ${name}`);
			}
			return v;
		},
		state: {
			get: stateGet,
			set: stateSet
		},
		workflow: { id: body.workflow.id, name: body.workflow.name }
	};
}
