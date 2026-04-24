import { getDb, now, uuid } from '../index.ts';
import { fetchAll, fetchOne } from '../mappers.ts';
import type { VersionCreatedBy, WorkflowVersion } from '../types.ts';

interface WorkflowVersionRow {
	id: string;
	workflow_id: string;
	version: number;
	source_ts: string;
	deploy_path: string;
	created_at: number;
	created_by: VersionCreatedBy;
	parent_version_id: string | null;
	healed_from_run_id: string | null;
}

export interface CreateVersionInput {
	workflowId: string;
	sourceTs: string;
	deployPath: string;
	createdBy: VersionCreatedBy;
	parentVersionId?: string | null;
	healedFromRunId?: string | null;
	setAsCurrent?: boolean;
}

export async function createVersion(input: CreateVersionInput): Promise<WorkflowVersion> {
	const id = uuid();
	const ts = now();
	const db = getDb();

	const maxRow = await db
		.prepare(
			`SELECT COALESCE(MAX(version), 0) AS max_version FROM workflow_versions WHERE workflow_id = ?`
		)
		.bind(input.workflowId)
		.first<{ max_version: number }>();
	const version = (maxRow?.max_version ?? 0) + 1;
	const parentVersionId = input.parentVersionId ?? null;
	const healedFromRunId = input.healedFromRunId ?? null;

	const insertStmt = db
		.prepare(
			`INSERT INTO workflow_versions
			 (id, workflow_id, version, source_ts, deploy_path, created_at, created_by, parent_version_id, healed_from_run_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			input.workflowId,
			version,
			input.sourceTs,
			input.deployPath,
			ts,
			input.createdBy,
			parentVersionId,
			healedFromRunId
		);

	if (input.setAsCurrent) {
		const updateStmt = db
			.prepare(`UPDATE workflows SET current_version_id = ?, updated_at = ? WHERE id = ?`)
			.bind(id, ts, input.workflowId);
		await db.batch([insertStmt, updateStmt]);
	} else {
		await insertStmt.run();
	}

	return {
		createdAt: ts,
		createdBy: input.createdBy,
		deployPath: input.deployPath,
		healedFromRunId,
		id,
		parentVersionId,
		sourceTs: input.sourceTs,
		version,
		workflowId: input.workflowId
	};
}

export async function getVersion(id: string): Promise<WorkflowVersion | null> {
	return fetchOne<WorkflowVersionRow, WorkflowVersion>(
		getDb().prepare(`SELECT * FROM workflow_versions WHERE id = ?`).bind(id)
	);
}

export async function getCurrentVersion(workflowId: string): Promise<WorkflowVersion | null> {
	return fetchOne<WorkflowVersionRow, WorkflowVersion>(
		getDb()
			.prepare(
				`SELECT v.* FROM workflow_versions v
				 JOIN workflows w ON w.current_version_id = v.id
				 WHERE w.id = ?`
			)
			.bind(workflowId)
	);
}

export async function listVersions(workflowId: string): Promise<WorkflowVersion[]> {
	return fetchAll<WorkflowVersionRow, WorkflowVersion>(
		getDb()
			.prepare(`SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version ASC`)
			.bind(workflowId)
	);
}
