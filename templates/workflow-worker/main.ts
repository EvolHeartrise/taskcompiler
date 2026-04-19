import workflow from "./workflow.js";
import { buildCtx, type WorkflowEnv } from "./ctx.js";
import { toErrorShape } from "./error.js";

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

interface InvokeResponse {
	ok: boolean;
	result?: unknown;
	error?: { name: string; message: string; stack?: string };
	logs: LogEntry[];
}

type WorkflowFn = (event: unknown, ctx: unknown) => Promise<unknown>;

function isInvokePayload(value: unknown): value is InvokePayload {
	if (!value || typeof value !== "object") return false;
	const v = value as { workflow?: unknown; event?: unknown };
	if (!v.workflow || typeof v.workflow !== "object") return false;
	if (!v.event || typeof v.event !== "object") return false;
	const wf = v.workflow as { id?: unknown; name?: unknown };
	const ev = v.event as {
		id?: unknown;
		triggerType?: unknown;
		receivedAt?: unknown;
	};
	if (typeof wf.id !== "string" || typeof wf.name !== "string") return false;
	if (typeof ev.id !== "string") return false;
	if (typeof ev.receivedAt !== "number") return false;
	if (
		ev.triggerType !== "webhook" &&
		ev.triggerType !== "cron" &&
		ev.triggerType !== "manual" &&
		ev.triggerType !== "replay"
	)
		return false;
	return true;
}

export default {
	async fetch(request: Request, env: WorkflowEnv): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("POST only", { status: 405 });
		}

		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return new Response("invalid json body", { status: 400 });
		}

		if (!isInvokePayload(raw)) {
			return new Response("invalid invoke payload", { status: 400 });
		}

		const body: InvokePayload = raw;
		const logs: LogEntry[] = [];
		const ctx = buildCtx(env, body, logs);

		try {
			const fn = workflow as unknown as WorkflowFn;
			if (typeof fn !== "function") {
				throw new Error("workflow module must export a default async function");
			}
			const result = await fn(body.event.payload, ctx);
			const response: InvokeResponse = { ok: true, result, logs };
			return Response.json(response);
		} catch (err) {
			const response: InvokeResponse = {
				ok: false,
				error: toErrorShape(err),
				logs,
			};
			return Response.json(response);
		}
	},
};
