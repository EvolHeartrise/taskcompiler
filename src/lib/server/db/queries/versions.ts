import { db, now, uuid } from "../index.ts";
import type { VersionCreatedBy, WorkflowVersion } from "../types.ts";

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

const insertStmt = db.prepare(
	`INSERT INTO workflow_versions
	 (id, workflow_id, version, source_ts, deploy_path, created_at, created_by, parent_version_id, healed_from_run_id)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const getStmt = db.prepare(`SELECT * FROM workflow_versions WHERE id = ?`);

const maxVersionStmt = db.prepare(
	`SELECT COALESCE(MAX(version), 0) AS max_version FROM workflow_versions WHERE workflow_id = ?`,
);

const getCurrentStmt = db.prepare(
	`SELECT v.* FROM workflow_versions v
	 JOIN workflows w ON w.current_version_id = v.id
	 WHERE w.id = ?`,
);

const listStmt = db.prepare(
	`SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version ASC`,
);

const updateWorkflowCurrentStmt = db.prepare(
	`UPDATE workflows SET current_version_id = ?, updated_at = ? WHERE id = ?`,
);

function rowToVersion(row: WorkflowVersionRow): WorkflowVersion {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		version: row.version,
		sourceTs: row.source_ts,
		deployPath: row.deploy_path,
		createdAt: row.created_at,
		createdBy: row.created_by,
		parentVersionId: row.parent_version_id,
		healedFromRunId: row.healed_from_run_id,
	};
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

export function createVersion(input: CreateVersionInput): WorkflowVersion {
	const id = uuid();
	const ts = now();

	const insert = (): WorkflowVersion => {
		const row = maxVersionStmt.get(input.workflowId) as { max_version: number };
		const version = row.max_version + 1;
		insertStmt.run(
			id,
			input.workflowId,
			version,
			input.sourceTs,
			input.deployPath,
			ts,
			input.createdBy,
			input.parentVersionId ?? null,
			input.healedFromRunId ?? null,
		);
		if (input.setAsCurrent) {
			updateWorkflowCurrentStmt.run(id, ts, input.workflowId);
		}
		const saved = getStmt.get(id) as WorkflowVersionRow;
		return rowToVersion(saved);
	};

	if (input.setAsCurrent) {
		return db.transaction(insert)();
	}
	return insert();
}

export function getVersion(id: string): WorkflowVersion | null {
	const row = getStmt.get(id) as WorkflowVersionRow | null;
	return row ? rowToVersion(row) : null;
}

export function getCurrentVersion(workflowId: string): WorkflowVersion | null {
	const row = getCurrentStmt.get(workflowId) as WorkflowVersionRow | null;
	return row ? rowToVersion(row) : null;
}

export function listVersions(workflowId: string): WorkflowVersion[] {
	const rows = listStmt.all(workflowId) as WorkflowVersionRow[];
	return rows.map(rowToVersion);
}
