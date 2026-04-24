import { getDb, now, uuid } from '../index.ts';
import { rowToDomain } from '../mappers.ts';
import { parseJson } from '$lib/server/util';
import type { Run, RunError, RunLogEntry, RunStatus } from '../types.ts';

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

const RUN_JSON_COLS = ['error_json', 'result_json', 'logs_json', 'is_replay'] as const;

function rowToRun(row: RunRow): Run {
	return rowToDomain<RunRow, Run>(row, RUN_JSON_COLS, {
		error: parseJson<RunError>(row.error_json),
		isReplay: row.is_replay !== 0,
		logs: parseJson<RunLogEntry[]>(row.logs_json),
		result: parseJson<unknown>(row.result_json)
	});
}

export interface CreateRunInput {
	eventId: string;
	workflowId: string;
	versionId: string;
	isReplay?: boolean;
	parentRunId?: string | null;
}

export async function createRun(input: CreateRunInput): Promise<Run> {
	const id = uuid();
	const startedAt = now();
	const isReplay = input.isReplay ?? false;
	const parentRunId = input.parentRunId ?? null;
	await getDb()
		.prepare(
			`INSERT INTO runs
			 (id, event_id, workflow_id, version_id, started_at, finished_at, status, error_json, result_json, logs_json, is_replay, parent_run_id)
			 VALUES (?, ?, ?, ?, ?, NULL, 'running', NULL, NULL, NULL, ?, ?)`
		)
		.bind(
			id,
			input.eventId,
			input.workflowId,
			input.versionId,
			startedAt,
			isReplay ? 1 : 0,
			parentRunId
		)
		.run();
	return {
		error: null,
		eventId: input.eventId,
		finishedAt: null,
		id,
		isReplay,
		logs: null,
		parentRunId,
		result: null,
		startedAt,
		status: 'running',
		versionId: input.versionId,
		workflowId: input.workflowId
	};
}

export async function finishRunOk(
	runId: string,
	result: unknown,
	logs: RunLogEntry[] | null
): Promise<Run | null> {
	await getDb()
		.prepare(
			`UPDATE runs SET status = 'ok', finished_at = ?, result_json = ?, logs_json = ? WHERE id = ?`
		)
		.bind(now(), JSON.stringify(result ?? null), logs ? JSON.stringify(logs) : null, runId)
		.run();
	return getRun(runId);
}

export async function finishRunFailed(
	runId: string,
	error: RunError,
	logs: RunLogEntry[] | null
): Promise<Run | null> {
	await getDb()
		.prepare(
			`UPDATE runs SET status = 'failed', finished_at = ?, error_json = ?, logs_json = ? WHERE id = ?`
		)
		.bind(now(), JSON.stringify(error), logs ? JSON.stringify(logs) : null, runId)
		.run();
	return getRun(runId);
}

export async function markRunSuperseded(runId: string): Promise<Run | null> {
	await getDb()
		.prepare(`UPDATE runs SET status = 'superseded', finished_at = ? WHERE id = ?`)
		.bind(now(), runId)
		.run();
	return getRun(runId);
}

export async function getRun(id: string): Promise<Run | null> {
	const row = await getDb().prepare(`SELECT * FROM runs WHERE id = ?`).bind(id).first<RunRow>();
	return row ? rowToRun(row) : null;
}

export async function listRunsForWorkflow(workflowId: string): Promise<Run[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM runs WHERE workflow_id = ? ORDER BY started_at DESC`)
		.bind(workflowId)
		.all<RunRow>();
	return res.results.map(rowToRun);
}

export async function listFailedRunsForWorkflow(workflowId: string): Promise<Run[]> {
	const res = await getDb()
		.prepare(
			`SELECT * FROM runs WHERE workflow_id = ? AND status = 'failed' ORDER BY started_at DESC`
		)
		.bind(workflowId)
		.all<RunRow>();
	return res.results.map(rowToRun);
}

export interface RunStats {
	total: number;
	failed: number;
}

// One query instead of N per-workflow list lookups.
export async function getRunStatsForProject(projectId: string): Promise<Map<string, RunStats>> {
	const res = await getDb()
		.prepare(
			`SELECT r.workflow_id AS workflow_id, r.status AS status, COUNT(*) AS count
			 FROM runs r
			 JOIN workflows w ON w.id = r.workflow_id
			 WHERE w.project_id = ?
			 GROUP BY r.workflow_id, r.status`
		)
		.bind(projectId)
		.all<{ workflow_id: string; status: RunStatus; count: number }>();
	const stats = new Map<string, RunStats>();
	for (const row of res.results) {
		const curr = stats.get(row.workflow_id) ?? { failed: 0, total: 0 };
		curr.total += row.count;
		if (row.status === 'failed') {
			curr.failed += row.count;
		}
		stats.set(row.workflow_id, curr);
	}
	return stats;
}

export async function listFailedRunsByEvent(workflowId: string): Promise<Run[]> {
	const res = await getDb()
		.prepare(
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
			 ORDER BY r.started_at DESC`
		)
		.bind(workflowId, workflowId)
		.all<RunRow>();
	return res.results.map(rowToRun);
}
