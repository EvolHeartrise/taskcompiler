import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { executeEvent } from "$lib/server/engine";
import { getWorkflow } from "$lib/server/db/queries/workflows";

type ExecResponse = Awaited<ReturnType<typeof executeEvent>>;

function errorJson(status: number, message: string): Response {
	return json({ error: { name: "TriggerError", message } }, { status });
}

async function parseBody(request: Request): Promise<{ ok: true; payload: unknown } | { ok: false }> {
	const ct = (request.headers.get("content-type") ?? "").toLowerCase();
	try {
		if (ct.includes("application/x-www-form-urlencoded")) {
			const text = await request.text();
			const params = new URLSearchParams(text);
			const obj: Record<string, string> = {};
			for (const [k, v] of params.entries()) obj[k] = v;
			return { ok: true, payload: obj };
		}
		if (ct.startsWith("text/")) {
			const text = await request.text();
			return { ok: true, payload: text };
		}
		const text = await request.text();
		if (text.length === 0) return { ok: true, payload: null };
		return { ok: true, payload: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

function toResponse(res: ExecResponse): Response {
	const body: Record<string, unknown> = {
		eventId: res.eventId,
		runId: res.runId,
		status: res.status,
	};
	if (res.result !== undefined) body.result = res.result;
	if (res.error !== undefined) body.error = res.error;
	return json(body, { status: 200 });
}

export const POST: RequestHandler = async ({ params, request }) => {
	const workflowId = params.workflowId;
	if (!workflowId) return errorJson(400, "missing workflowId");

	const wf = await getWorkflow(workflowId);
	if (!wf) return errorJson(404, "workflow not found");

	const parsed = await parseBody(request);
	if (!parsed.ok) return errorJson(400, "invalid request body");

	try {
		const res = await executeEvent({
			workflowId,
			trigger: "webhook",
			payload: parsed.payload,
		});
		return toResponse(res);
	} catch (err) {
		const e = err as Error;
		return json(
			{ error: { name: e.name ?? "Error", message: e.message ?? String(err) } },
			{ status: 500 },
		);
	}
};

export const GET: RequestHandler = async ({ params, url }) => {
	const workflowId = params.workflowId;
	if (!workflowId) return errorJson(400, "missing workflowId");

	const wf = await getWorkflow(workflowId);
	if (!wf) return errorJson(404, "workflow not found");

	const payload: Record<string, string> = {};
	for (const [k, v] of url.searchParams.entries()) payload[k] = v;

	try {
		const res = await executeEvent({
			workflowId,
			trigger: "webhook",
			payload,
		});
		return toResponse(res);
	} catch (err) {
		const e = err as Error;
		return json(
			{ error: { name: e.name ?? "Error", message: e.message ?? String(err) } },
			{ status: 500 },
		);
	}
};
