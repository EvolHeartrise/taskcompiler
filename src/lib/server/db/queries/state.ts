import { db, now } from "../index.ts";
import type { WorkflowStateEntry } from "../types.ts";

interface WorkflowStateRow {
	workflow_id: string;
	key: string;
	value_json: string;
	updated_at: number;
}

const getStmt = db.prepare(
	`SELECT * FROM workflow_state WHERE workflow_id = ? AND key = ?`,
);

const upsertStmt = db.prepare(
	`INSERT INTO workflow_state (workflow_id, key, value_json, updated_at)
	 VALUES (?, ?, ?, ?)
	 ON CONFLICT(workflow_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
);

const listStmt = db.prepare(
	`SELECT * FROM workflow_state WHERE workflow_id = ? ORDER BY key ASC`,
);

function rowToEntry(row: WorkflowStateRow): WorkflowStateEntry {
	return {
		workflowId: row.workflow_id,
		key: row.key,
		value: JSON.parse(row.value_json) as unknown,
		updatedAt: row.updated_at,
	};
}

export function getState(workflowId: string, key: string): unknown {
	const row = getStmt.get(workflowId, key) as WorkflowStateRow | null;
	if (!row) return undefined;
	return JSON.parse(row.value_json) as unknown;
}

export function setState(workflowId: string, key: string, value: unknown): void {
	upsertStmt.run(workflowId, key, JSON.stringify(value ?? null), now());
}

export function listState(workflowId: string): WorkflowStateEntry[] {
	const rows = listStmt.all(workflowId) as WorkflowStateRow[];
	return rows.map(rowToEntry);
}
