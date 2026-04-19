import { getDb, now, uuid } from '../index.ts';
import type { TriggerType, Workflow } from '../types.ts';

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

function rowToWorkflow(row: WorkflowRow): Workflow {
	return {
		id: row.id,
		name: row.name,
		prompt: row.prompt,
		currentVersionId: row.current_version_id,
		triggerType: row.trigger_type,
		cronExpr: row.cron_expr,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export interface CreateWorkflowInput {
	id?: string;
	name: string;
	prompt: string;
	triggerType: TriggerType;
	cronExpr?: string | null;
}

export async function createWorkflow(input: CreateWorkflowInput): Promise<Workflow> {
	const id = input.id ?? uuid();
	const ts = now();
	await getDb()
		.prepare(
			`INSERT INTO workflows (id, name, prompt, current_version_id, trigger_type, cron_expr, created_at, updated_at)
			 VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
		)
		.bind(id, input.name, input.prompt, input.triggerType, input.cronExpr ?? null, ts, ts)
		.run();
	const row = await getDb()
		.prepare(`SELECT * FROM workflows WHERE id = ?`)
		.bind(id)
		.first<WorkflowRow>();
	if (!row) throw new Error(`createWorkflow: row missing after insert (id=${id})`);
	return rowToWorkflow(row);
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
	const row = await getDb()
		.prepare(`SELECT * FROM workflows WHERE id = ?`)
		.bind(id)
		.first<WorkflowRow>();
	return row ? rowToWorkflow(row) : null;
}

export async function listWorkflows(): Promise<Workflow[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM workflows ORDER BY created_at DESC`)
		.all<WorkflowRow>();
	return res.results.map(rowToWorkflow);
}

export interface UpdateWorkflowInput {
	name?: string;
	cronExpr?: string | null;
	currentVersionId?: string | null;
	triggerType?: TriggerType;
}

export async function updateWorkflow(
	id: string,
	patch: UpdateWorkflowInput
): Promise<Workflow | null> {
	const existing = await getWorkflow(id);
	if (!existing) return null;
	const next: Workflow = {
		...existing,
		name: patch.name ?? existing.name,
		cronExpr: patch.cronExpr === undefined ? existing.cronExpr : patch.cronExpr,
		currentVersionId:
			patch.currentVersionId === undefined ? existing.currentVersionId : patch.currentVersionId,
		triggerType: patch.triggerType ?? existing.triggerType,
		updatedAt: now()
	};
	await getDb()
		.prepare(
			`UPDATE workflows
			 SET name = ?, cron_expr = ?, current_version_id = ?, trigger_type = ?, updated_at = ?
			 WHERE id = ?`
		)
		.bind(next.name, next.cronExpr, next.currentVersionId, next.triggerType, next.updatedAt, id)
		.run();
	return next;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
	const res = await getDb().prepare(`DELETE FROM workflows WHERE id = ?`).bind(id).run();
	return (res.meta.changes ?? 0) > 0;
}
