// Inbound webhook ingestion: redact headers + persist the event.
//
// Decoupled from execution so the hook handler can persist regardless of
// Whether the workflow is ready to invoke. Headers are redacted at this
// Boundary (auth/signature stripped, CF noise dropped) before they ever
// Touch D1 or reach the user's workflow code.

import { createEvent } from '$lib/server/db/queries/events';
import type { Event } from '$lib/server/db/types';
import { redactHeaders } from './redact';

export interface IngestWebhookInput {
	workflowId: string;
	payload: unknown;
	rawHeaders: Headers | Record<string, string>;
}

export interface IngestWebhookResult {
	event: Event;
}

export async function ingestWebhookEvent(input: IngestWebhookInput): Promise<IngestWebhookResult> {
	const headers = redactHeaders(input.rawHeaders);
	const event = await createEvent({
		headers,
		payload: input.payload,
		triggerType: 'webhook',
		workflowId: input.workflowId
	});
	return { event };
}
