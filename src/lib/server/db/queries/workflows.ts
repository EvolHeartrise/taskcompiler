import { getDb, mapRow, now, uuid } from '../index.ts';
import type { Workflow } from '../types.ts';

interface WorkflowRow {
	id: string;
	project_id: string;
	event_source_id: string;
	name: string;
	prompt: string;
	current_version_id: string | null;
	created_at: number;
	updated_at: number;
}

export interface CreateWorkflowInput {
	id?: string;
	projectId: string;
	eventSourceId: string;
	name: string;
	prompt: string;
}

export async function createWorkflow(input: CreateWorkflowInput): Promise<Workflow> {
	const id = input.id ?? uuid();
	const ts = now();
	await getDb()
		.prepare(
			`INSERT INTO workflows (id, project_id, event_source_id, name, prompt, current_version_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
		)
		.bind(id, input.projectId, input.eventSourceId, input.name, input.prompt, ts, ts)
		.run();
	return {
		createdAt: ts,
		currentVersionId: null,
		eventSourceId: input.eventSourceId,
		id,
		name: input.name,
		projectId: input.projectId,
		prompt: input.prompt,
		updatedAt: ts
	};
}

// System-level lookup (cron/webhook/executor/heal). Does not enforce project_id;
// Callers already trust the id. Prefer `getWorkflowForProject` in UI code paths.
export async function getWorkflow(id: string): Promise<Workflow | null> {
	const row = await getDb()
		.prepare(`SELECT * FROM workflows WHERE id = ?`)
		.bind(id)
		.first<WorkflowRow>();
	return row ? mapRow<Workflow>(row) : null;
}

export async function getWorkflowForProject(
	id: string,
	projectId: string
): Promise<Workflow | null> {
	const row = await getDb()
		.prepare(`SELECT * FROM workflows WHERE id = ? AND project_id = ?`)
		.bind(id, projectId)
		.first<WorkflowRow>();
	return row ? mapRow<Workflow>(row) : null;
}

export async function listWorkflowsForProject(projectId: string): Promise<Workflow[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at DESC`)
		.bind(projectId)
		.all<WorkflowRow>();
	return res.results.map((r) => mapRow<Workflow>(r));
}

export async function listWorkflowsForEventSource(eventSourceId: string): Promise<Workflow[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM workflows WHERE event_source_id = ? ORDER BY created_at DESC`)
		.bind(eventSourceId)
		.all<WorkflowRow>();
	return res.results.map((r) => mapRow<Workflow>(r));
}

// Batched workflow counts per source for a project — one query instead of N
// Per-source list lookups from the home loader.
export async function countWorkflowsBySourceForProject(
	projectId: string
): Promise<Map<string, number>> {
	const res = await getDb()
		.prepare(
			`SELECT event_source_id AS source_id, COUNT(*) AS count
			 FROM workflows
			 WHERE project_id = ?
			 GROUP BY event_source_id`
		)
		.bind(projectId)
		.all<{ source_id: string; count: number }>();
	return new Map(res.results.map((r) => [r.source_id, r.count]));
}

export interface UpdateWorkflowInput {
	name?: string;
	currentVersionId?: string | null;
}

export async function updateWorkflow(
	id: string,
	patch: UpdateWorkflowInput
): Promise<Workflow | null> {
	const existing = await getWorkflow(id);
	if (!existing) {
		return null;
	}
	const next: Workflow = {
		...existing,
		currentVersionId:
			patch.currentVersionId === undefined ? existing.currentVersionId : patch.currentVersionId,
		name: patch.name ?? existing.name,
		updatedAt: now()
	};
	await getDb()
		.prepare(
			`UPDATE workflows
			 SET name = ?, current_version_id = ?, updated_at = ?
			 WHERE id = ?`
		)
		.bind(next.name, next.currentVersionId, next.updatedAt, id)
		.run();
	return next;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
	// Ordered cascade for workflow-owned rows. Events are NOT owned by the
	// Workflow anymore — they belong to the event_source — so we leave them
	// Alone. The schema has several non-CASCADE FKs between child tables
	// (heal_sessions → runs, workflow_versions → runs, versions → versions,
	// Runs → runs) plus a circular ref workflows.current_version_id ↔
	// Workflow_versions.workflow_id. We null the cross-child references
	// First and then delete rows in an order that respects the remaining FKs,
	// All as a single batched transaction so a mid-delete failure rolls back.
	const db = getDb();
	const results = await db.batch([
		db.prepare(`UPDATE workflows SET current_version_id = NULL WHERE id = ?`).bind(id),
		db
			.prepare(`UPDATE workflow_versions SET healed_from_run_id = NULL WHERE workflow_id = ?`)
			.bind(id),
		db
			.prepare(`UPDATE workflow_versions SET parent_version_id = NULL WHERE workflow_id = ?`)
			.bind(id),
		db.prepare(`UPDATE runs SET parent_run_id = NULL WHERE workflow_id = ?`).bind(id),
		db.prepare(`DELETE FROM heal_sessions WHERE workflow_id = ?`).bind(id),
		db.prepare(`DELETE FROM runs WHERE workflow_id = ?`).bind(id),
		db.prepare(`DELETE FROM workflow_versions WHERE workflow_id = ?`).bind(id),
		db.prepare(`DELETE FROM workflow_state WHERE workflow_id = ?`).bind(id),
		db.prepare(`DELETE FROM workflows WHERE id = ?`).bind(id)
	]);
	const last = results.at(-1);
	return (last?.meta?.changes ?? 0) > 0;
}
