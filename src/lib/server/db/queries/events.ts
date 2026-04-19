import { db, now, uuid } from "../index.ts";
import type { Event, EventTriggerType } from "../types.ts";

interface EventRow {
	id: string;
	workflow_id: string;
	trigger_type: EventTriggerType;
	payload_json: string;
	received_at: number;
	dedup_key: string | null;
}

const insertStmt = db.prepare(
	`INSERT INTO events (id, workflow_id, trigger_type, payload_json, received_at, dedup_key)
	 VALUES (?, ?, ?, ?, ?, ?)`,
);

const getStmt = db.prepare(`SELECT * FROM events WHERE id = ?`);

const listForWorkflowLimitStmt = db.prepare(
	`SELECT * FROM events WHERE workflow_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT ?`,
);
const listForWorkflowStmt = db.prepare(
	`SELECT * FROM events WHERE workflow_id = ? AND received_at >= ? ORDER BY received_at DESC`,
);

const listAllForWorkflowStmt = db.prepare(
	`SELECT * FROM events WHERE workflow_id = ? ORDER BY received_at ASC`,
);

function rowToEvent(row: EventRow): Event {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		triggerType: row.trigger_type,
		payload: JSON.parse(row.payload_json) as unknown,
		receivedAt: row.received_at,
		dedupKey: row.dedup_key,
	};
}

export interface CreateEventInput {
	workflowId: string;
	triggerType: EventTriggerType;
	payload: unknown;
	dedupKey?: string | null;
	receivedAt?: number;
}

export function createEvent(input: CreateEventInput): Event {
	const id = uuid();
	const receivedAt = input.receivedAt ?? now();
	insertStmt.run(
		id,
		input.workflowId,
		input.triggerType,
		JSON.stringify(input.payload ?? null),
		receivedAt,
		input.dedupKey ?? null,
	);
	const row = getStmt.get(id) as EventRow;
	return rowToEvent(row);
}

export function getEvent(id: string): Event | null {
	const row = getStmt.get(id) as EventRow | null;
	return row ? rowToEvent(row) : null;
}

export interface ListEventsOptions {
	limit?: number;
	since?: number;
}

export function listEventsForWorkflow(
	workflowId: string,
	opts: ListEventsOptions = {},
): Event[] {
	const since = opts.since ?? 0;
	const rows =
		opts.limit !== undefined
			? (listForWorkflowLimitStmt.all(workflowId, since, opts.limit) as EventRow[])
			: (listForWorkflowStmt.all(workflowId, since) as EventRow[]);
	return rows.map(rowToEvent);
}

export function listAllEventsForWorkflow(workflowId: string): Event[] {
	const rows = listAllForWorkflowStmt.all(workflowId) as EventRow[];
	return rows.map(rowToEvent);
}
