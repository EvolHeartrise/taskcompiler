import { getDb, now, uuid } from '../index.ts';
import { mapRow } from '../mappers.ts';
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

function rowToEvent(row: EventRow): Event {
	return {
		...mapRow<Omit<Event, 'payload' | 'headers'>>(row, ['payload_json', 'headers_json']),
		headers: parseJsonOrThrow<Record<string, string>>(row.headers_json, 'event.headers_json'),
		payload: parseJsonOrThrow<unknown>(row.payload_json, 'event.payload_json')
	};
}

export interface CreateEventInput {
	eventSourceId: string;
	triggerType: EventTriggerType;
	payload: unknown;
	headers?: Record<string, string>;
	dedupKey?: string | null;
	receivedAt?: number;
}

export async function createEvent(input: CreateEventInput): Promise<Event> {
	const id = uuid();
	const receivedAt = input.receivedAt ?? now();
	const payload = input.payload ?? null;
	const headers = input.headers ?? {};
	const dedupKey = input.dedupKey ?? null;
	await getDb()
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

export async function getEvent(id: string): Promise<Event | null> {
	const row = await getDb().prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first<EventRow>();
	return row ? rowToEvent(row) : null;
}

export interface ListEventsOptions {
	limit?: number;
	since?: number;
}

// SQLite treats a negative LIMIT as unbounded, letting us express "no limit"
// In a single parameterised query instead of branching the statement.
export async function listEventsForSource(
	sourceId: string,
	opts: ListEventsOptions = {}
): Promise<Event[]> {
	const res = await getDb()
		.prepare(
			`SELECT * FROM events WHERE event_source_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT ?`
		)
		.bind(sourceId, opts.since ?? 0, opts.limit ?? -1)
		.all<EventRow>();
	return res.results.map(rowToEvent);
}

// Convenience: list events for a workflow by joining on its event_source_id.
// Used by the UI and agent tools so callers don't need to do the join.
export async function listEventsForWorkflow(
	workflowId: string,
	opts: ListEventsOptions = {}
): Promise<Event[]> {
	const res = await getDb()
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

export async function listAllEventsForWorkflow(workflowId: string): Promise<Event[]> {
	const res = await getDb()
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

export async function countEventsForSource(sourceId: string): Promise<number> {
	const row = await getDb()
		.prepare(`SELECT COUNT(*) AS count FROM events WHERE event_source_id = ?`)
		.bind(sourceId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

// Batched event counts for a project — one query instead of N per-source
// Counts from the home loader.
export async function countEventsBySourceForProject(
	projectId: string
): Promise<Map<string, number>> {
	const res = await getDb()
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
