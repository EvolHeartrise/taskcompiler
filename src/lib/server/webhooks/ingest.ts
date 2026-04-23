// Inbound webhook ingestion: redact headers + hand off to the executor for
// Fanout. Headers are redacted at this boundary (auth/signature stripped, CF
// Noise dropped) before they ever touch D1 or reach user workflow code.
//
// The bootstrap worker constructs the user-visible `{ body, headers }` event
// From `event.payload` + `event.headers`, so here we persist those two as
// Separate fields and do NOT pre-wrap them.

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
