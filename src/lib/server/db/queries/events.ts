import { getDb, now, uuid } from '../index.ts';
import type { Event, EventTriggerType } from '../types.ts';

interface EventRow {
	id: string;
	workflow_id: string;
	trigger_type: EventTriggerType;
	payload_json: string;
	headers_json: string;
	received_at: number;
	dedup_key: string | null;
}

function rowToEvent(row: EventRow): Event {
	return {
		dedupKey: row.dedup_key,
		headers: JSON.parse(row.headers_json) as Record<string, string>,
		id: row.id,
		payload: JSON.parse(row.payload_json) as unknown,
		receivedAt: row.received_at,
		triggerType: row.trigger_type,
		workflowId: row.workflow_id
	};
}

export interface CreateEventInput {
	workflowId: string;
	triggerType: EventTriggerType;
	payload: unknown;
	headers?: Record<string, string>;
	dedupKey?: string | null;
	receivedAt?: number;
}

export async function createEvent(input: CreateEventInput): Promise<Event> {
	const id = uuid();
	const receivedAt = input.receivedAt ?? now();
	await getDb()
		.prepare(
			`INSERT INTO events (id, workflow_id, trigger_type, payload_json, headers_json, received_at, dedup_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			input.workflowId,
			input.triggerType,
			JSON.stringify(input.payload ?? null),
			JSON.stringify(input.headers ?? {}),
			receivedAt,
			input.dedupKey ?? null
		)
		.run();
	const row = await getDb().prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first<EventRow>();
	if (!row) {
		throw new Error(`createEvent: row missing after insert (id=${id})`);
	}
	return rowToEvent(row);
}

export async function getEvent(id: string): Promise<Event | null> {
	const row = await getDb().prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first<EventRow>();
	return row ? rowToEvent(row) : null;
}

export interface ListEventsOptions {
	limit?: number;
	since?: number;
}

export async function listEventsForWorkflow(
	workflowId: string,
	opts: ListEventsOptions = {}
): Promise<Event[]> {
	const since = opts.since ?? 0;
	const db = getDb();
	const res =
		opts.limit !== undefined
			? await db
					.prepare(
						`SELECT * FROM events WHERE workflow_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT ?`
					)
					.bind(workflowId, since, opts.limit)
					.all<EventRow>()
			: await db
					.prepare(
						`SELECT * FROM events WHERE workflow_id = ? AND received_at >= ? ORDER BY received_at DESC`
					)
					.bind(workflowId, since)
					.all<EventRow>();
	return res.results.map(rowToEvent);
}

export async function listAllEventsForWorkflow(workflowId: string): Promise<Event[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM events WHERE workflow_id = ? ORDER BY received_at ASC`)
		.bind(workflowId)
		.all<EventRow>();
	return res.results.map(rowToEvent);
}
