import { getState, setState } from "$lib/server/db/queries/state";
import type { Event, RunLogEntry, Workflow } from "$lib/server/db/types";

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
	if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams)
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
	return Object.keys(h).some((k) => k.toLowerCase() === needle);
}

export function createContext(
	workflow: Workflow,
	event: Event,
): { ctx: Ctx; getLogs: () => RunLogEntry[] } {
	const logs: RunLogEntry[] = [];

	const log: Ctx["log"] = (level, message, data) => {
		const entry: RunLogEntry = { level, message, ts: Date.now() };
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

	const ctx: Ctx = {
		workflow: { id: workflow.id, name: workflow.name },
		event: {
			id: event.id,
			triggerType: event.triggerType,
			receivedAt: event.receivedAt,
		},
		http: {
			fetch: instrumentedFetch,
			get: httpGet,
			post: httpPost,
		},
		log,
		state: {
			get: async <T = unknown>(key: string): Promise<T | undefined> => {
				const value = await getState(workflow.id, key);
				return value === undefined ? undefined : (value as T);
			},
			set: async (key: string, value: unknown): Promise<void> => {
				await setState(workflow.id, key, value);
			},
		},
		secret: (name: string): string => {
			const v = process.env[name];
			if (v === undefined || v === "") {
				throw new Error(`Secret not set: ${name}`);
			}
			return v;
		},
	};

	return { ctx, getLogs: () => logs };
}
