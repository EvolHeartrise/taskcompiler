// Inbound webhook ingestion pipeline.
//
//   Redact headers → infer shape → hash → persist event → upsert event_shape
//   → on new shape: LRS-evict + regenerate cached WorkflowEvent type.
//
// Decoupled from execution: callers decide whether to invoke the workflow
// Based on its status / currentVersionId. This keeps shape capture working
// Even before the workflow has been generated, which is what enables the
// "wait for first event, then generate" flow (phase 3).

import { createEvent } from '$lib/server/db/queries/events';
import {
	evictLeastRecentlySeen,
	listEventShapesForWorkflow,
	upsertEventShape
} from '$lib/server/db/queries/event-shapes';
import { setInferredEventType } from '$lib/server/db/queries/workflows';
import type { Event } from '$lib/server/db/types';
import { emitWorkflowEventType } from '$lib/server/inference/emit';
import { hashShape, inferShape, shapeFromJson, shapeToJson } from '$lib/server/inference/shape';
import { redactHeaders } from './redact';

const SHAPE_CAP_PER_WORKFLOW = 500;

export interface IngestWebhookInput {
	workflowId: string;
	payload: unknown;
	rawHeaders: Headers | Record<string, string>;
}

export interface IngestWebhookResult {
	event: Event;
	isNewShape: boolean;
	shapeHash: string;
}

export async function ingestWebhookEvent(input: IngestWebhookInput): Promise<IngestWebhookResult> {
	const headers = redactHeaders(input.rawHeaders);
	const shape = inferShape({ body: input.payload, headers });
	const shapeHash = await hashShape(shape);
	const shapeJson = shapeToJson(shape);

	const event = await createEvent({
		headers,
		payload: input.payload,
		shapeHash,
		triggerType: 'webhook',
		workflowId: input.workflowId
	});

	const upsert = await upsertEventShape({
		sampleHeaders: headers,
		samplePayload: input.payload,
		shapeHash,
		shapeJson,
		workflowId: input.workflowId
	});

	if (upsert.isNew) {
		await evictLeastRecentlySeen(input.workflowId, SHAPE_CAP_PER_WORKFLOW);
		await regenerateInferredType(input.workflowId);
	}

	return { event, isNewShape: upsert.isNew, shapeHash };
}

async function regenerateInferredType(workflowId: string): Promise<void> {
	const stored = await listEventShapesForWorkflow(workflowId);
	const shapes = stored.map((s) => shapeFromJson(s.shapeJson));
	const ts = emitWorkflowEventType(shapes);
	await setInferredEventType(workflowId, ts);
}
