interface D1Result {
	value_json: string;
}

interface D1PreparedStatement {
	bind: (...values: unknown[]) => D1PreparedStatement;
	first: <T = unknown>() => Promise<T | null>;
	run: () => Promise<unknown>;
}

interface D1Database {
	prepare: (query: string) => D1PreparedStatement;
}

export interface WorkflowEnv {
	DB: D1Database;
	[key: string]: unknown;
}

interface InvokePayload {
	workflow: { id: string; name: string };
	event: {
		id: string;
		triggerType: "webhook" | "cron" | "manual" | "replay";
		receivedAt: number;
		payload: unknown;
	};
}

interface LogEntry {
	level: "debug" | "info" | "warn" | "error";
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
	log: (
		level: "debug" | "info" | "warn" | "error",
		message: string,
		data?: unknown,
	) => void;
	state: {
		get: <T = unknown>(key: string) => Promise<T | undefined>;
		set: (key: string, value: unknown) => Promise<void>;
	};
	secret: (name: string) => string;
}

function isBodyLike(value: unknown): boolean {
	if (typeof value === "string") return true;
	if (value instanceof ArrayBuffer) return true;
	if (ArrayBuffer.isView(value)) return true;
	if (typeof FormData !== "undefined" && value instanceof FormData) return true;
	if (
		typeof URLSearchParams !== "undefined" &&
		value instanceof URLSearchParams
	)
		return true;
	if (typeof Blob !== "undefined" && value instanceof Blob) return true;
	if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
		return true;
	return false;
}

function headerHas(init: RequestInit | undefined, name: string): boolean {
	const h = init?.headers;
	if (!h) return false;
	const needle = name.toLowerCase();
	if (h instanceof Headers) return h.has(name);
	if (Array.isArray(h)) {
		return h.some(([k]) => k.toLowerCase() === needle);
	}
	return Object.keys(h as Record<string, string>).some(
		(k) => k.toLowerCase() === needle,
	);
}

export function buildCtx(
	env: WorkflowEnv,
	body: InvokePayload,
	logs: LogEntry[],
): Ctx {
	const workflowId = body.workflow.id;

	const log: Ctx["log"] = (level, message, data) => {
		const entry: LogEntry = { level, message, ts: Date.now() };
		if (data !== undefined) entry.data = data;
		logs.push(entry);
	};

	const instrumentedFetch = async (
		input: string | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const method = (init?.method ?? "GET").toUpperCase();
		const url = typeof input === "string" ? input : input.toString();
		const started = Date.now();
		try {
			const res = await fetch(input, init);
			logs.push({
				level: "info",
				message: "http",
				ts: Date.now(),
				data: { method, url, status: res.status, ms: Date.now() - started },
			});
			return res;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logs.push({
				level: "error",
				message: "http",
				ts: Date.now(),
				data: { method, url, error: message, ms: Date.now() - started },
			});
			throw err;
		}
	};

	const httpGet = (url: string, init?: RequestInit): Promise<Response> =>
		instrumentedFetch(url, { ...init, method: "GET" });

	const httpPost = (
		url: string,
		body?: unknown,
		init?: RequestInit,
	): Promise<Response> => {
		const headers = new Headers(init?.headers);
		let bodyInit: BodyInit | undefined;
		if (body === undefined || body === null) {
			bodyInit = undefined;
		} else if (isBodyLike(body)) {
			bodyInit = body as BodyInit;
		} else {
			bodyInit = JSON.stringify(body);
			if (!headerHas(init, "content-type")) {
				headers.set("Content-Type", "application/json");
			}
		}
		return instrumentedFetch(url, {
			...init,
			method: "POST",
			headers,
			body: bodyInit,
		});
	};

	const stateGet = async <T = unknown>(key: string): Promise<T | undefined> => {
		const row = await env.DB.prepare(
			`SELECT value_json FROM workflow_state WHERE workflow_id = ? AND key = ?`,
		)
			.bind(workflowId, key)
			.first<D1Result>();
		if (!row) return undefined;
		return JSON.parse(row.value_json) as T;
	};

	const stateSet = async (key: string, value: unknown): Promise<void> => {
		await env.DB.prepare(
			`INSERT INTO workflow_state (workflow_id, key, value_json, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(workflow_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		)
			.bind(workflowId, key, JSON.stringify(value ?? null), Date.now())
			.run();
	};

	return {
		workflow: { id: body.workflow.id, name: body.workflow.name },
		event: {
			id: body.event.id,
			triggerType: body.event.triggerType,
			receivedAt: body.event.receivedAt,
		},
		http: {
			fetch: instrumentedFetch,
			get: httpGet,
			post: httpPost,
		},
		log,
		state: {
			get: stateGet,
			set: stateSet,
		},
		secret: (name: string): string => {
			const v = env[name];
			if (typeof v !== "string" || v === "") {
				throw new Error(`Secret not set: ${name}`);
			}
			return v;
		},
	};
}
