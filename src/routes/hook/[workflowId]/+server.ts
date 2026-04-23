import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { executeExistingEvent } from '$lib/server/engine';
import { getWorkflow } from '$lib/server/db/queries/workflows';
import { ingestWebhookEvent } from '$lib/server/webhooks/ingest';

type ExecResponse = Awaited<ReturnType<typeof executeExistingEvent>>;

function errorJson(status: number, message: string): Response {
	return json({ error: { message, name: 'TriggerError' } }, { status });
}

async function parseBody(
	request: Request
): Promise<{ ok: true; payload: unknown } | { ok: false }> {
	const ct = (request.headers.get('content-type') ?? '').toLowerCase();
	try {
		if (ct.includes('application/x-www-form-urlencoded')) {
			const text = await request.text();
			const params = new URLSearchParams(text);
			const obj: Record<string, string> = {};
			for (const [k, v] of params.entries()) {
				obj[k] = v;
			}
			return { ok: true, payload: obj };
		}
		if (ct.startsWith('text/')) {
			const text = await request.text();
			return { ok: true, payload: text };
		}
		const text = await request.text();
		if (text.length === 0) {
			return { ok: true, payload: null };
		}
		return { ok: true, payload: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

function executedResponse(res: ExecResponse): Response {
	const body: Record<string, unknown> = {
		eventId: res.eventId,
		runId: res.runId,
		status: res.status
	};
	if (res.result !== undefined) {
		body.result = res.result;
	}
	if (res.error !== undefined) {
		body.error = res.error;
	}
	return json(body, { status: 200 });
}

function pendingResponse(eventId: string): Response {
	// 202 Accepted: event captured but workflow isn't ready to execute (no
	// Current version yet — generation hasn't completed). The event will be
	// Available for replay once generation lands.
	return json({ eventId, status: 'pending' as const }, { status: 202 });
}

export const POST: RequestHandler = async ({ params, request }) => {
	const { workflowId } = params;
	if (!workflowId) {
		return errorJson(400, 'missing workflowId');
	}

	const wf = await getWorkflow(workflowId);
	if (!wf) {
		return errorJson(404, 'workflow not found');
	}
	if (wf.triggerType !== 'webhook') {
		return errorJson(400, `workflow trigger is '${wf.triggerType}', not 'webhook'`);
	}

	const parsed = await parseBody(request);
	if (!parsed.ok) {
		return errorJson(400, 'invalid request body');
	}

	try {
		const ingest = await ingestWebhookEvent({
			payload: parsed.payload,
			rawHeaders: request.headers,
			workflowId
		});

		if (!wf.currentVersionId) {
			return pendingResponse(ingest.event.id);
		}

		const res = await executeExistingEvent(ingest.event.id);
		return executedResponse(res);
	} catch (error) {
		const e = error as Error;
		return json(
			{ error: { message: e.message ?? String(error), name: e.name ?? 'Error' } },
			{ status: 500 }
		);
	}
};

export const GET: RequestHandler = async ({ params, request, url }) => {
	const { workflowId } = params;
	if (!workflowId) {
		return errorJson(400, 'missing workflowId');
	}

	const wf = await getWorkflow(workflowId);
	if (!wf) {
		return errorJson(404, 'workflow not found');
	}
	if (wf.triggerType !== 'webhook') {
		return errorJson(400, `workflow trigger is '${wf.triggerType}', not 'webhook'`);
	}

	const payload: Record<string, string> = {};
	for (const [k, v] of url.searchParams.entries()) {
		payload[k] = v;
	}

	try {
		const ingest = await ingestWebhookEvent({
			payload,
			rawHeaders: request.headers,
			workflowId
		});

		if (!wf.currentVersionId) {
			return pendingResponse(ingest.event.id);
		}

		const res = await executeExistingEvent(ingest.event.id);
		return executedResponse(res);
	} catch (error) {
		const e = error as Error;
		return json(
			{ error: { message: e.message ?? String(error), name: e.name ?? 'Error' } },
			{ status: 500 }
		);
	}
};
