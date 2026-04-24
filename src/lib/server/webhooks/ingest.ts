// Headers are redacted here so secrets never reach D1 or user workflow code.
// Payload + headers are persisted as separate fields (not pre-wrapped): the
// bootstrap worker reconstructs the `{ body, headers }` event at runtime.

import { type ExecuteSourceEventResult, executeSourceEvent } from '$lib/server/engine';
import { redactHeaders } from './redact';

export interface IngestWebhookInput {
	eventSourceId: string;
	payload: unknown;
	rawHeaders: Headers | Record<string, string>;
}

export async function ingestWebhookEvent(
	input: IngestWebhookInput
): Promise<ExecuteSourceEventResult> {
	const headers = redactHeaders(input.rawHeaders);
	return executeSourceEvent({
		eventSourceId: input.eventSourceId,
		headers,
		payload: input.payload,
		trigger: 'webhook'
	});
}
