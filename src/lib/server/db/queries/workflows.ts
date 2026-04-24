import { now, uuid } from '../index.ts';
import { fetchAll, fetchOne } from '../mappers.ts';
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

export async function createWorkflow(
	db: D1Database,
	input: CreateWorkflowInput
): Promise<Workflow> {
	const id = input.id ?? uuid();
	const ts = now();
	await db
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

// System-level lookup — does not enforce project_id. Prefer
// `getWorkflowForProject` in UI code paths.
export async function getWorkflow(db: D1Database, id: string): Promise<Workflow | null> {
	return fetchOne<WorkflowRow, Workflow>(
		db.prepare(`SELECT * FROM workflows WHERE id = ?`).bind(id)
	);
}

export async function getWorkflowForProject(
	db: D1Database,
	id: string,
	projectId: string
): Promise<Workflow | null> {
	return fetchOne<WorkflowRow, Workflow>(
		db.prepare(`SELECT * FROM workflows WHERE id = ? AND project_id = ?`).bind(id, projectId)
	);
}

export async function listWorkflowsForProject(
	db: D1Database,
	projectId: string
): Promise<Workflow[]> {
	return fetchAll<WorkflowRow, Workflow>(
		db
			.prepare(`SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at DESC`)
			.bind(projectId)
	);
}

export async function listWorkflowsForEventSource(
	db: D1Database,
	eventSourceId: string
): Promise<Workflow[]> {
	return fetchAll<WorkflowRow, Workflow>(
		db
			.prepare(`SELECT * FROM workflows WHERE event_source_id = ? ORDER BY created_at DESC`)
			.bind(eventSourceId)
	);
}

// One query instead of N per-source list lookups.
export async function countWorkflowsBySourceForProject(
	db: D1Database,
	projectId: string
): Promise<Map<string, number>> {
	const res = await db
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
	db: D1Database,
	id: string,
	patch: UpdateWorkflowInput
): Promise<Workflow | null> {
	const existing = await getWorkflow(db, id);
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
	await db
		.prepare(
			`UPDATE workflows
			 SET name = ?, current_version_id = ?, updated_at = ?
			 WHERE id = ?`
		)
		.bind(next.name, next.currentVersionId, next.updatedAt, id)
		.run();
	return next;
}

export async function deleteWorkflow(db: D1Database, id: string): Promise<boolean> {
	// Events belong to the event_source, not the workflow, so they're left
	// intact. The schema has several non-CASCADE FKs between child tables
	// (heal_sessions → runs, workflow_versions → runs, versions → versions,
	// runs → runs) plus a circular ref workflows.current_version_id ↔
	// workflow_versions.workflow_id, so cross-child references are nulled
	// first and rows are deleted in FK-safe order inside one batched
	// transaction — a mid-delete failure rolls back.
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
