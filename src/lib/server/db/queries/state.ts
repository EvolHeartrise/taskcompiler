import { getDb, now } from '../index.ts';
import type { WorkflowStateEntry } from '../types.ts';

interface WorkflowStateRow {
	workflow_id: string;
	key: string;
	value_json: string;
	updated_at: number;
}

function rowToEntry(row: WorkflowStateRow): WorkflowStateEntry {
	return {
		key: row.key,
		updatedAt: row.updated_at,
		value: JSON.parse(row.value_json) as unknown,
		workflowId: row.workflow_id
	};
}

export async function getState(workflowId: string, key: string): Promise<unknown> {
	const row = await getDb()
		.prepare(`SELECT * FROM workflow_state WHERE workflow_id = ? AND key = ?`)
		.bind(workflowId, key)
		.first<WorkflowStateRow>();
	if (!row) {
		return undefined;
	}
	return JSON.parse(row.value_json) as unknown;
}

export async function setState(workflowId: string, key: string, value: unknown): Promise<void> {
	await getDb()
		.prepare(
			`INSERT INTO workflow_state (workflow_id, key, value_json, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(workflow_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
		)
		.bind(workflowId, key, JSON.stringify(value ?? null), now())
		.run();
}

export async function listState(workflowId: string): Promise<WorkflowStateEntry[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM workflow_state WHERE workflow_id = ? ORDER BY key ASC`)
		.bind(workflowId)
		.all<WorkflowStateRow>();
	return res.results.map(rowToEntry);
}
