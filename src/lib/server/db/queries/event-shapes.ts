import { getDb, now } from '../index.ts';
import type { EventShape } from '../types.ts';

interface EventShapeRow {
	workflow_id: string;
	shape_hash: string;
	shape_json: string;
	sample_payload_json: string;
	sample_headers_json: string;
	first_seen: number;
	last_seen: number;
	count: number;
}

function rowToEventShape(row: EventShapeRow): EventShape {
	return {
		count: row.count,
		firstSeen: row.first_seen,
		lastSeen: row.last_seen,
		sampleHeaders: JSON.parse(row.sample_headers_json) as Record<string, string>,
		samplePayload: JSON.parse(row.sample_payload_json) as unknown,
		shapeHash: row.shape_hash,
		shapeJson: row.shape_json,
		workflowId: row.workflow_id
	};
}

const DEFAULT_SHAPE_CAP = 500;

export interface UpsertEventShapeInput {
	workflowId: string;
	shapeHash: string;
	shapeJson: string;
	samplePayload: unknown;
	sampleHeaders: Record<string, string>;
}

export interface UpsertEventShapeResult {
	isNew: boolean;
	shape: EventShape;
}

export async function upsertEventShape(
	input: UpsertEventShapeInput
): Promise<UpsertEventShapeResult> {
	const db = getDb();
	const ts = now();
	const existing = await db
		.prepare(`SELECT * FROM event_shapes WHERE workflow_id = ? AND shape_hash = ?`)
		.bind(input.workflowId, input.shapeHash)
		.first<EventShapeRow>();
	if (existing) {
		await db
			.prepare(
				`UPDATE event_shapes SET last_seen = ?, count = count + 1 WHERE workflow_id = ? AND shape_hash = ?`
			)
			.bind(ts, input.workflowId, input.shapeHash)
			.run();
		return {
			isNew: false,
			shape: { ...rowToEventShape(existing), count: existing.count + 1, lastSeen: ts }
		};
	}
	await db
		.prepare(
			`INSERT INTO event_shapes (workflow_id, shape_hash, shape_json, sample_payload_json, sample_headers_json, first_seen, last_seen, count)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
		)
		.bind(
			input.workflowId,
			input.shapeHash,
			input.shapeJson,
			JSON.stringify(input.samplePayload ?? null),
			JSON.stringify(input.sampleHeaders),
			ts,
			ts
		)
		.run();
	return {
		isNew: true,
		shape: {
			count: 1,
			firstSeen: ts,
			lastSeen: ts,
			sampleHeaders: input.sampleHeaders,
			samplePayload: input.samplePayload,
			shapeHash: input.shapeHash,
			shapeJson: input.shapeJson,
			workflowId: input.workflowId
		}
	};
}

export async function listEventShapesForWorkflow(workflowId: string): Promise<EventShape[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM event_shapes WHERE workflow_id = ? ORDER BY first_seen ASC`)
		.bind(workflowId)
		.all<EventShapeRow>();
	return res.results.map(rowToEventShape);
}

export async function countEventShapesForWorkflow(workflowId: string): Promise<number> {
	const row = await getDb()
		.prepare(`SELECT COUNT(*) as n FROM event_shapes WHERE workflow_id = ?`)
		.bind(workflowId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

// LRS eviction: drop down to `max` shapes by deleting the least-recently-seen.
// No-op when count <= max. Bound on cost: deletes (count - max) rows.
export async function evictLeastRecentlySeen(
	workflowId: string,
	max: number = DEFAULT_SHAPE_CAP
): Promise<number> {
	const total = await countEventShapesForWorkflow(workflowId);
	if (total <= max) {
		return 0;
	}
	const toDrop = total - max;
	const res = await getDb()
		.prepare(
			`DELETE FROM event_shapes
			 WHERE workflow_id = ?
			   AND shape_hash IN (
			     SELECT shape_hash FROM event_shapes
			     WHERE workflow_id = ?
			     ORDER BY last_seen ASC
			     LIMIT ?
			   )`
		)
		.bind(workflowId, workflowId, toDrop)
		.run();
	return res.meta?.changes ?? 0;
}
