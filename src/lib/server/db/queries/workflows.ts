import { getDb, now, uuid } from '../index.ts';
import type { TriggerType, Workflow, WorkflowStatus } from '../types.ts';

interface WorkflowRow {
	id: string;
	project_id: string;
	name: string;
	prompt: string;
	current_version_id: string | null;
	trigger_type: TriggerType;
	cron_expr: string | null;
	status: WorkflowStatus;
	inferred_event_type_ts: string | null;
	inferred_at: number | null;
	created_at: number;
	updated_at: number;
	last_fired_at: number;
}

function rowToWorkflow(row: WorkflowRow): Workflow {
	return {
		createdAt: row.created_at,
		cronExpr: row.cron_expr,
		currentVersionId: row.current_version_id,
		id: row.id,
		inferredAt: row.inferred_at,
		inferredEventTypeTs: row.inferred_event_type_ts,
		lastFiredAt: row.last_fired_at,
		name: row.name,
		projectId: row.project_id,
		prompt: row.prompt,
		status: row.status,
		triggerType: row.trigger_type,
		updatedAt: row.updated_at
	};
}

export interface CreateWorkflowInput {
	id?: string;
	projectId: string;
	name: string;
	prompt: string;
	triggerType: TriggerType;
	cronExpr?: string | null;
	status?: WorkflowStatus;
}

export async function createWorkflow(input: CreateWorkflowInput): Promise<Workflow> {
	const id = input.id ?? uuid();
	const ts = now();
	const status: WorkflowStatus =
		input.status ?? (input.triggerType === 'webhook' ? 'awaiting_first_event' : 'generating');
	await getDb()
		.prepare(
			`INSERT INTO workflows (id, project_id, name, prompt, current_version_id, trigger_type, cron_expr, status, inferred_event_type_ts, inferred_at, created_at, updated_at, last_fired_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, 0)`
		)
		.bind(
			id,
			input.projectId,
			input.name,
			input.prompt,
			input.triggerType,
			input.cronExpr ?? null,
			status,
			ts,
			ts
		)
		.run();
	const row = await getDb()
		.prepare(`SELECT * FROM workflows WHERE id = ?`)
		.bind(id)
		.first<WorkflowRow>();
	if (!row) {
		throw new Error(`createWorkflow: row missing after insert (id=${id})`);
	}
	return rowToWorkflow(row);
}

// System-level lookup (cron/webhook/executor/heal). Does not enforce project_id;
// Callers already trust the id. Prefer `getWorkflowForProject` in UI code paths.
export async function getWorkflow(id: string): Promise<Workflow | null> {
	const row = await getDb()
		.prepare(`SELECT * FROM workflows WHERE id = ?`)
		.bind(id)
		.first<WorkflowRow>();
	return row ? rowToWorkflow(row) : null;
}

export async function getWorkflowForProject(
	id: string,
	projectId: string
): Promise<Workflow | null> {
	const row = await getDb()
		.prepare(`SELECT * FROM workflows WHERE id = ? AND project_id = ?`)
		.bind(id, projectId)
		.first<WorkflowRow>();
	return row ? rowToWorkflow(row) : null;
}

export async function listWorkflowsForProject(projectId: string): Promise<Workflow[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at DESC`)
		.bind(projectId)
		.all<WorkflowRow>();
	return res.results.map(rowToWorkflow);
}

export interface UpdateWorkflowInput {
	name?: string;
	cronExpr?: string | null;
	currentVersionId?: string | null;
	triggerType?: TriggerType;
	status?: WorkflowStatus;
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
		cronExpr: patch.cronExpr === undefined ? existing.cronExpr : patch.cronExpr,
		currentVersionId:
			patch.currentVersionId === undefined ? existing.currentVersionId : patch.currentVersionId,
		name: patch.name ?? existing.name,
		status: patch.status ?? existing.status,
		triggerType: patch.triggerType ?? existing.triggerType,
		updatedAt: now()
	};
	await getDb()
		.prepare(
			`UPDATE workflows
			 SET name = ?, cron_expr = ?, current_version_id = ?, trigger_type = ?, status = ?, updated_at = ?
			 WHERE id = ?`
		)
		.bind(
			next.name,
			next.cronExpr,
			next.currentVersionId,
			next.triggerType,
			next.status,
			next.updatedAt,
			id
		)
		.run();
	return next;
}

// Atomic transition awaiting_first_event → generating. Returns true if this
// Caller won the race; the winner is responsible for kicking off GEN_WORKFLOW.
export async function claimAwaitingForGeneration(workflowId: string): Promise<boolean> {
	const res = await getDb()
		.prepare(
			`UPDATE workflows SET status = 'generating', updated_at = ?
			 WHERE id = ? AND status = 'awaiting_first_event'`
		)
		.bind(now(), workflowId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

export async function setInferredEventType(
	workflowId: string,
	typeTs: string | null
): Promise<void> {
	const ts = typeTs === null ? null : now();
	await getDb()
		.prepare(
			`UPDATE workflows SET inferred_event_type_ts = ?, inferred_at = ?, updated_at = ? WHERE id = ?`
		)
		.bind(typeTs, ts, now(), workflowId)
		.run();
}

export async function deleteWorkflow(id: string): Promise<boolean> {
	// Ordered cascade. The schema has several non-CASCADE FKs between child
	// Tables (heal_sessions → runs, workflow_versions → runs, versions → versions,
	// Runs → runs) plus a circular ref workflows.current_version_id ↔
	// Workflow_versions.workflow_id. We null the cross-child references first
	// And then delete rows in an order that respects the remaining FKs, all
	// As a single batched transaction so a mid-delete failure rolls back.
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
		db.prepare(`DELETE FROM event_shapes WHERE workflow_id = ?`).bind(id),
		db.prepare(`DELETE FROM events WHERE workflow_id = ?`).bind(id),
		db.prepare(`DELETE FROM workflow_state WHERE workflow_id = ?`).bind(id),
		db.prepare(`DELETE FROM workflows WHERE id = ?`).bind(id)
	]);
	const last = results.at(-1);
	return (last?.meta?.changes ?? 0) > 0;
}

export async function listCronWorkflows(): Promise<Workflow[]> {
	const res = await getDb()
		.prepare(
			`SELECT * FROM workflows
			 WHERE trigger_type = 'cron' AND cron_expr IS NOT NULL
			 ORDER BY last_fired_at ASC`
		)
		.all<WorkflowRow>();
	return res.results.map(rowToWorkflow);
}

export async function markWorkflowFired(workflowId: string, ts: number): Promise<void> {
	await getDb()
		.prepare(`UPDATE workflows SET last_fired_at = ? WHERE id = ?`)
		.bind(ts, workflowId)
		.run();
}
