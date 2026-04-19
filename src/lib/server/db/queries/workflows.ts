import { db, now, uuid } from "../index.ts";
import type { TriggerType, Workflow } from "../types.ts";

interface WorkflowRow {
	id: string;
	name: string;
	prompt: string;
	current_version_id: string | null;
	trigger_type: TriggerType;
	cron_expr: string | null;
	created_at: number;
	updated_at: number;
}

const insertStmt = db.prepare(
	`INSERT INTO workflows (id, name, prompt, current_version_id, trigger_type, cron_expr, created_at, updated_at)
	 VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
);

const getStmt = db.prepare(`SELECT * FROM workflows WHERE id = ?`);
const listStmt = db.prepare(`SELECT * FROM workflows ORDER BY created_at DESC`);
const deleteStmt = db.prepare(`DELETE FROM workflows WHERE id = ?`);

function rowToWorkflow(row: WorkflowRow): Workflow {
	return {
		id: row.id,
		name: row.name,
		prompt: row.prompt,
		currentVersionId: row.current_version_id,
		triggerType: row.trigger_type,
		cronExpr: row.cron_expr,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export interface CreateWorkflowInput {
	name: string;
	prompt: string;
	triggerType: TriggerType;
	cronExpr?: string | null;
}

export function createWorkflow(input: CreateWorkflowInput): Workflow {
	const id = uuid();
	const ts = now();
	insertStmt.run(
		id,
		input.name,
		input.prompt,
		input.triggerType,
		input.cronExpr ?? null,
		ts,
		ts,
	);
	const row = getStmt.get(id) as WorkflowRow;
	return rowToWorkflow(row);
}

export function getWorkflow(id: string): Workflow | null {
	const row = getStmt.get(id) as WorkflowRow | null;
	return row ? rowToWorkflow(row) : null;
}

export function listWorkflows(): Workflow[] {
	const rows = listStmt.all() as WorkflowRow[];
	return rows.map(rowToWorkflow);
}

export interface UpdateWorkflowInput {
	name?: string;
	cronExpr?: string | null;
	currentVersionId?: string | null;
	triggerType?: TriggerType;
}

export function updateWorkflow(id: string, patch: UpdateWorkflowInput): Workflow | null {
	const existing = getWorkflow(id);
	if (!existing) return null;
	const next: Workflow = {
		...existing,
		name: patch.name ?? existing.name,
		cronExpr: patch.cronExpr === undefined ? existing.cronExpr : patch.cronExpr,
		currentVersionId:
			patch.currentVersionId === undefined
				? existing.currentVersionId
				: patch.currentVersionId,
		triggerType: patch.triggerType ?? existing.triggerType,
		updatedAt: now(),
	};
	db.prepare(
		`UPDATE workflows
		 SET name = ?, cron_expr = ?, current_version_id = ?, trigger_type = ?, updated_at = ?
		 WHERE id = ?`,
	).run(
		next.name,
		next.cronExpr,
		next.currentVersionId,
		next.triggerType,
		next.updatedAt,
		id,
	);
	return next;
}

export function deleteWorkflow(id: string): boolean {
	const res = deleteStmt.run(id);
	return res.changes > 0;
}
