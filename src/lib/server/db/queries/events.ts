import { now, uuid } from '../index.ts';
import { rowToDomain } from '../mappers.ts';
import { parseJsonOrThrow } from '$lib/server/util';
import type { Event, EventTriggerType } from '../types.ts';

interface EventRow {
	id: string;
	event_source_id: string;
	trigger_type: EventTriggerType;
	payload_json: string;
	headers_json: string;
	received_at: number;
	dedup_key: string | null;
}

const EVENT_JSON_COLS = ['payload_json', 'headers_json'] as const;

function rowToEvent(row: EventRow): Event {
	return rowToDomain<EventRow, Event>(row, EVENT_JSON_COLS, {
		headers: parseJsonOrThrow<Record<string, string>>(row.headers_json, 'event.headers_json'),
		payload: parseJsonOrThrow<unknown>(row.payload_json, 'event.payload_json')
	});
}

export interface CreateEventInput {
	eventSourceId: string;
	triggerType: EventTriggerType;
	payload: unknown;
	headers?: Record<string, string>;
	dedupKey?: string | null;
	receivedAt?: number;
}

export async function createEvent(db: D1Database, input: CreateEventInput): Promise<Event> {
	const id = uuid();
	const receivedAt = input.receivedAt ?? now();
	const payload = input.payload ?? null;
	const headers = input.headers ?? {};
	const dedupKey = input.dedupKey ?? null;
	await db
		.prepare(
			`INSERT INTO events (id, event_source_id, trigger_type, payload_json, headers_json, received_at, dedup_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			input.eventSourceId,
			input.triggerType,
			JSON.stringify(payload),
			JSON.stringify(headers),
			receivedAt,
			dedupKey
		)
		.run();
	return {
		dedupKey,
		eventSourceId: input.eventSourceId,
		headers,
		id,
		payload,
		receivedAt,
		triggerType: input.triggerType
	};
}

export async function getEvent(db: D1Database, id: string): Promise<Event | null> {
	const row = await db.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first<EventRow>();
	return row ? rowToEvent(row) : null;
}

export interface ListEventsOptions {
	limit?: number;
	since?: number;
}

// SQLite treats a negative LIMIT as unbounded, so "no limit" is a single
// parameterised query instead of a branched statement.
export async function listEventsForSource(
	db: D1Database,
	sourceId: string,
	opts: ListEventsOptions = {}
): Promise<Event[]> {
	const res = await db
		.prepare(
			`SELECT * FROM events WHERE event_source_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT ?`
		)
		.bind(sourceId, opts.since ?? 0, opts.limit ?? -1)
		.all<EventRow>();
	return res.results.map(rowToEvent);
}

export async function listEventsForWorkflow(
	db: D1Database,
	workflowId: string,
	opts: ListEventsOptions = {}
): Promise<Event[]> {
	const res = await db
		.prepare(
			`SELECT e.* FROM events e
			 JOIN workflows w ON w.event_source_id = e.event_source_id
			 WHERE w.id = ? AND e.received_at >= ?
			 ORDER BY e.received_at DESC LIMIT ?`
		)
		.bind(workflowId, opts.since ?? 0, opts.limit ?? -1)
		.all<EventRow>();
	return res.results.map(rowToEvent);
}

export async function listAllEventsForWorkflow(
	db: D1Database,
	workflowId: string
): Promise<Event[]> {
	const res = await db
		.prepare(
			`SELECT e.* FROM events e
			 JOIN workflows w ON w.event_source_id = e.event_source_id
			 WHERE w.id = ?
			 ORDER BY e.received_at ASC`
		)
		.bind(workflowId)
		.all<EventRow>();
	return res.results.map(rowToEvent);
}

// Events for a workflow that have no corresponding `runs` row — i.e. the
// workflow was paused (or had no current version) when the event landed, so
// the executor persisted the event but skipped the run insert. The opt-in
// backfill loop (task 14) consumes this list in received_at ASC order.
// `limit` bounds the per-iteration page size so an arbitrarily large
// deferred queue doesn't blow the Worker's memory budget; the backfill
// loop re-queries between batches to pick up late arrivals.
export async function listUnrunEventsForWorkflow(
	db: D1Database,
	workflowId: string,
	limit = 100
): Promise<Event[]> {
	const res = await db
		.prepare(
			`SELECT e.* FROM events e
			 JOIN workflows w ON w.event_source_id = e.event_source_id
			 LEFT JOIN runs r ON r.event_id = e.id AND r.workflow_id = w.id
			 WHERE w.id = ?
			   AND r.id IS NULL
			 ORDER BY e.received_at ASC
			 LIMIT ?`
		)
		.bind(workflowId, limit)
		.all<EventRow>();
	return res.results.map(rowToEvent);
}

export async function countUnrunEventsForWorkflow(
	db: D1Database,
	workflowId: string
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM events e
			 JOIN workflows w ON w.event_source_id = e.event_source_id
			 LEFT JOIN runs r ON r.event_id = e.id AND r.workflow_id = w.id
			 WHERE w.id = ? AND r.id IS NULL`
		)
		.bind(workflowId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

export async function countEventsForSource(db: D1Database, sourceId: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS count FROM events WHERE event_source_id = ?`)
		.bind(sourceId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

// One query instead of N per-source counts.
export async function countEventsBySourceForProject(
	db: D1Database,
	projectId: string
): Promise<Map<string, number>> {
	const res = await db
		.prepare(
			`SELECT e.event_source_id AS source_id, COUNT(*) AS count
			 FROM events e
			 JOIN event_sources s ON s.id = e.event_source_id
			 WHERE s.project_id = ?
			 GROUP BY e.event_source_id`
		)
		.bind(projectId)
		.all<{ source_id: string; count: number }>();
	return new Map(res.results.map((r) => [r.source_id, r.count]));
}
