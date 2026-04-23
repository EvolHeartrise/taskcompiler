import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEventSource } from '$lib/server/db/queries/event-sources';
import { ingestWebhookEvent } from '$lib/server/webhooks/ingest';
import type { ExecuteSourceEventResult } from '$lib/server/engine';

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

// Fanout response summarizes the event capture and every workflow dispatch.
// Each workflow that ran gets its runId + status; workflows still generating
// Are reported as skipped so the caller knows the event was captured but
// Not delivered there yet.
function fanoutResponse(res: ExecuteSourceEventResult): Response {
	return json(
		{
			dispatched: res.dispatched.map((d) => ({
				error: d.error ?? null,
				result: d.result ?? null,
				runId: d.runId || null,
				skipped: d.skipped ?? null,
				status: d.status,
				workflowId: d.workflowId
			})),
			eventId: res.eventId,
			eventSourceId: res.eventSourceId
		},
		{ status: 200 }
	);
}

async function handle(
	sourceId: string | undefined,
	headers: Headers,
	extractPayload: () => Promise<{ ok: true; payload: unknown } | { ok: false }>
): Promise<Response> {
	if (!sourceId) {
		return errorJson(400, 'missing sourceId');
	}
	const source = await getEventSource(sourceId);
	if (!source) {
		return errorJson(404, 'event source not found');
	}
	if (source.triggerType !== 'webhook') {
		return errorJson(400, `event source trigger is '${source.triggerType}', not 'webhook'`);
	}
	const parsed = await extractPayload();
	if (!parsed.ok) {
		return errorJson(400, 'invalid request body');
	}
	try {
		const res = await ingestWebhookEvent({
			eventSourceId: source.id,
			payload: parsed.payload,
			rawHeaders: headers
		});
		return fanoutResponse(res);
	} catch (error) {
		const e = error as Error;
		return json(
			{ error: { message: e.message ?? String(error), name: e.name ?? 'Error' } },
			{ status: 500 }
		);
	}
}

export const POST: RequestHandler = ({ params, request }) =>
	handle(params.sourceId, request.headers, () => parseBody(request));

export const GET: RequestHandler = ({ params, request, url }) =>
	handle(params.sourceId, request.headers, () => {
		const payload: Record<string, string> = {};
		for (const [k, v] of url.searchParams.entries()) {
			payload[k] = v;
		}
		return Promise.resolve({ ok: true, payload });
	});
