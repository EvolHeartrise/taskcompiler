// Headers are redacted here so secrets never reach D1 or user workflow code.
// Payload + headers are persisted as separate fields (not pre-wrapped): the
// bootstrap worker reconstructs the `{ body, headers }` event at runtime.

import { type ExecuteSourceEventResult, executeSourceEvent } from '$lib/server/engine';
import { createLogger } from '$lib/server/log';
import { EVENTS } from '$lib/server/log-events';
import { redactHeaders } from './redact';

const log = createLogger('webhook');

export interface IngestWebhookInput {
	eventSourceId: string;
	payload: unknown;
	rawHeaders: Headers | Record<string, string>;
}

export async function ingestWebhookEvent(
	env: Env,
	input: IngestWebhookInput
): Promise<ExecuteSourceEventResult> {
	const headers = redactHeaders(input.rawHeaders);
	const result = await executeSourceEvent(env, {
		eventSourceId: input.eventSourceId,
		headers,
		payload: input.payload,
		trigger: 'webhook'
	});
	log.info(EVENTS.WEBHOOK_INGESTED, {
		event_source_id: input.eventSourceId,
		event_id: result.eventId,
		dispatched: result.dispatched.length
	});
	return result;
}
