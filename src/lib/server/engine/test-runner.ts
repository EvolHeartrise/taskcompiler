import { transform } from "sucrase";
import type { Event, RunError, RunLogEntry, Workflow } from "$lib/server/db/types";
import type { Ctx } from "./context";

export interface EphemeralRunResult {
	ok: boolean;
	error?: RunError;
	logs: RunLogEntry[];
	result?: unknown;
	durationMs: number;
}

type WorkflowRun = (event: unknown, ctx: Ctx) => Promise<unknown>;

interface WorkflowModule {
	default?: unknown;
}

function toRunError(err: unknown): RunError {
	if (err instanceof Error) {
		const out: RunError = {
			name: err.name || "Error",
			message: err.message || String(err),
		};
		if (err.stack) out.stack = err.stack;
		return out;
	}
	if (typeof err === "object" && err !== null) {
		const anyErr = err as { name?: unknown; message?: unknown; stack?: unknown };
		const out: RunError = {
			name: typeof anyErr.name === "string" ? anyErr.name : "NonError",
			message:
				typeof anyErr.message === "string" ? anyErr.message : safeStringify(err),
		};
		if (typeof anyErr.stack === "string") out.stack = anyErr.stack;
		return out;
	}
	return { name: "NonError", message: safeStringify(err) };
}

function safeStringify(v: unknown): string {
	try {
		return typeof v === "string" ? v : JSON.stringify(v);
	} catch {
		return String(v);
	}
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

function createEphemeralContext(
	workflow: Workflow,
	event: Event,
): { ctx: Ctx; getLogs: () => RunLogEntry[] } {
	const logs: RunLogEntry[] = [];
	const stateStore = new Map<string, unknown>();

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
				const value = stateStore.get(key);
				return value === undefined ? undefined : (value as T);
			},
			set: async (key: string, value: unknown): Promise<void> => {
				stateStore.set(key, value);
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

function isWorkflowRun(value: unknown): value is WorkflowRun {
	return typeof value === "function";
}

export async function runAgainstEventEphemeral(
	sourceTs: string,
	event: Event,
	workflow: Workflow,
): Promise<EphemeralRunResult> {
	const started = Date.now();

	let js: string;
	try {
		const { code } = transform(sourceTs, { transforms: ["typescript"] });
		js = code;
	} catch (err) {
		return {
			ok: false,
			error: toRunError(err),
			logs: [],
			durationMs: Date.now() - started,
		};
	}

	const dataUrl = `data:text/javascript;base64,${Buffer.from(js, "utf-8").toString("base64")}`;

	let mod: WorkflowModule;
	try {
		mod = (await import(dataUrl)) as WorkflowModule;
	} catch (err) {
		return {
			ok: false,
			error: toRunError(err),
			logs: [],
			durationMs: Date.now() - started,
		};
	}

	const exported = mod.default;
	if (!isWorkflowRun(exported)) {
		return {
			ok: false,
			error: {
				name: "Error",
				message: "Workflow source must export a default async function",
			},
			logs: [],
			durationMs: Date.now() - started,
		};
	}

	const { ctx, getLogs } = createEphemeralContext(workflow, event);

	try {
		const result = await exported(event.payload, ctx);
		return {
			ok: true,
			result,
			logs: getLogs(),
			durationMs: Date.now() - started,
		};
	} catch (err) {
		return {
			ok: false,
			error: toRunError(err),
			logs: getLogs(),
			durationMs: Date.now() - started,
		};
	}
}
