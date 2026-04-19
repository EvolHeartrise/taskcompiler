import { db, now, uuid } from "../index.ts";
import type { Run, RunError, RunLogEntry, RunStatus } from "../types.ts";

interface RunRow {
	id: string;
	event_id: string;
	workflow_id: string;
	version_id: string;
	started_at: number;
	finished_at: number | null;
	status: RunStatus;
	error_json: string | null;
	result_json: string | null;
	logs_json: string | null;
	is_replay: number;
	parent_run_id: string | null;
}

const insertStmt = db.prepare(
	`INSERT INTO runs
	 (id, event_id, workflow_id, version_id, started_at, finished_at, status, error_json, result_json, logs_json, is_replay, parent_run_id)
	 VALUES (?, ?, ?, ?, ?, NULL, 'running', NULL, NULL, NULL, ?, ?)`,
);

const finishOkStmt = db.prepare(
	`UPDATE runs SET status = 'ok', finished_at = ?, result_json = ?, logs_json = ? WHERE id = ?`,
);

const finishFailedStmt = db.prepare(
	`UPDATE runs SET status = 'failed', finished_at = ?, error_json = ?, logs_json = ? WHERE id = ?`,
);

const supersedeStmt = db.prepare(
	`UPDATE runs SET status = 'superseded', finished_at = ? WHERE id = ?`,
);

const getStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);

const listForWorkflowStmt = db.prepare(
	`SELECT * FROM runs WHERE workflow_id = ? ORDER BY started_at DESC`,
);

const listFailedForWorkflowStmt = db.prepare(
	`SELECT * FROM runs WHERE workflow_id = ? AND status = 'failed' ORDER BY started_at DESC`,
);

const listFailedLatestByEventStmt = db.prepare(
	`SELECT r.* FROM runs r
	 JOIN (
	   SELECT event_id, MAX(started_at) AS latest
	   FROM runs
	   WHERE workflow_id = ?
	   GROUP BY event_id
	 ) latest_per_event
	   ON latest_per_event.event_id = r.event_id
	   AND latest_per_event.latest = r.started_at
	 WHERE r.workflow_id = ? AND r.status = 'failed'
	 ORDER BY r.started_at DESC`,
);

function parseJson<T>(s: string | null): T | null {
	if (s === null) return null;
	return JSON.parse(s) as T;
}

function rowToRun(row: RunRow): Run {
	return {
		id: row.id,
		eventId: row.event_id,
		workflowId: row.workflow_id,
		versionId: row.version_id,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		status: row.status,
		error: parseJson<RunError>(row.error_json),
		result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
		logs: parseJson<RunLogEntry[]>(row.logs_json),
		isReplay: row.is_replay !== 0,
		parentRunId: row.parent_run_id,
	};
}

export interface CreateRunInput {
	eventId: string;
	workflowId: string;
	versionId: string;
	isReplay?: boolean;
	parentRunId?: string | null;
}

export function createRun(input: CreateRunInput): Run {
	const id = uuid();
	const startedAt = now();
	insertStmt.run(
		id,
		input.eventId,
		input.workflowId,
		input.versionId,
		startedAt,
		input.isReplay ? 1 : 0,
		input.parentRunId ?? null,
	);
	const row = getStmt.get(id) as RunRow;
	return rowToRun(row);
}

export function finishRunOk(
	runId: string,
	result: unknown,
	logs: RunLogEntry[] | null,
): Run | null {
	finishOkStmt.run(
		now(),
		JSON.stringify(result ?? null),
		logs ? JSON.stringify(logs) : null,
		runId,
	);
	return getRun(runId);
}

export function finishRunFailed(
	runId: string,
	error: RunError,
	logs: RunLogEntry[] | null,
): Run | null {
	finishFailedStmt.run(
		now(),
		JSON.stringify(error),
		logs ? JSON.stringify(logs) : null,
		runId,
	);
	return getRun(runId);
}

export function markRunSuperseded(runId: string): Run | null {
	supersedeStmt.run(now(), runId);
	return getRun(runId);
}

export function getRun(id: string): Run | null {
	const row = getStmt.get(id) as RunRow | null;
	return row ? rowToRun(row) : null;
}

export function listRunsForWorkflow(workflowId: string): Run[] {
	const rows = listForWorkflowStmt.all(workflowId) as RunRow[];
	return rows.map(rowToRun);
}

export function listFailedRunsForWorkflow(workflowId: string): Run[] {
	const rows = listFailedForWorkflowStmt.all(workflowId) as RunRow[];
	return rows.map(rowToRun);
}

export function listFailedRunsByEvent(workflowId: string): Run[] {
	const rows = listFailedLatestByEventStmt.all(workflowId, workflowId) as RunRow[];
	return rows.map(rowToRun);
}
