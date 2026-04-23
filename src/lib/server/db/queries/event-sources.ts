import { getDb, mapRow, now, uuid } from '../index.ts';
import type { EventSource, TriggerType } from '../types.ts';

interface EventSourceRow {
	id: string;
	project_id: string;
	name: string;
	trigger_type: TriggerType;
	cron_expr: string | null;
	created_at: number;
	updated_at: number;
	last_fired_at: number;
}

function rowToEventSource(row: EventSourceRow): EventSource {
	return mapRow<EventSource>(row);
}

export interface CreateEventSourceInput {
	id?: string;
	projectId: string;
	name: string;
	triggerType: TriggerType;
	cronExpr?: string | null;
}

export async function createEventSource(input: CreateEventSourceInput): Promise<EventSource> {
	const id = input.id ?? uuid();
	const ts = now();
	const cronExpr = input.cronExpr ?? null;
	await getDb()
		.prepare(
			`INSERT INTO event_sources
			 (id, project_id, name, trigger_type, cron_expr, created_at, updated_at, last_fired_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
		)
		.bind(id, input.projectId, input.name, input.triggerType, cronExpr, ts, ts)
		.run();
	return {
		createdAt: ts,
		cronExpr,
		id,
		lastFiredAt: 0,
		name: input.name,
		projectId: input.projectId,
		triggerType: input.triggerType,
		updatedAt: ts
	};
}

// System-level lookup (cron/webhook/executor). Does not enforce project_id —
// Callers already trust the id. Prefer `getEventSourceForProject` in UI code paths.
export async function getEventSource(id: string): Promise<EventSource | null> {
	const row = await getDb()
		.prepare(`SELECT * FROM event_sources WHERE id = ?`)
		.bind(id)
		.first<EventSourceRow>();
	return row ? rowToEventSource(row) : null;
}

export async function getEventSourceForProject(
	id: string,
	projectId: string
): Promise<EventSource | null> {
	const row = await getDb()
		.prepare(`SELECT * FROM event_sources WHERE id = ? AND project_id = ?`)
		.bind(id, projectId)
		.first<EventSourceRow>();
	return row ? rowToEventSource(row) : null;
}

export async function listEventSourcesForProject(projectId: string): Promise<EventSource[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM event_sources WHERE project_id = ? ORDER BY created_at DESC`)
		.bind(projectId)
		.all<EventSourceRow>();
	return res.results.map(rowToEventSource);
}

export async function listCronEventSources(): Promise<EventSource[]> {
	const res = await getDb()
		.prepare(
			`SELECT * FROM event_sources
			 WHERE trigger_type = 'cron' AND cron_expr IS NOT NULL
			 ORDER BY last_fired_at ASC`
		)
		.all<EventSourceRow>();
	return res.results.map(rowToEventSource);
}

export async function markEventSourceFired(sourceId: string, ts: number): Promise<void> {
	await getDb()
		.prepare(`UPDATE event_sources SET last_fired_at = ? WHERE id = ?`)
		.bind(ts, sourceId)
		.run();
}

export async function deleteEventSource(id: string): Promise<boolean> {
	const res = await getDb().prepare(`DELETE FROM event_sources WHERE id = ?`).bind(id).run();
	return (res.meta?.changes ?? 0) > 0;
}
