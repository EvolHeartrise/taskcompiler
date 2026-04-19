import { db, now, uuid } from "../index.ts";
import type {
	HealAgentTranscriptEntry,
	HealSession,
	HealStatus,
	HealTestResults,
} from "../types.ts";

interface HealSessionRow {
	id: string;
	workflow_id: string;
	triggering_run_id: string;
	started_at: number;
	finished_at: number | null;
	status: HealStatus;
	diff: string | null;
	test_results_json: string | null;
	new_version_id: string | null;
	agent_transcript_json: string | null;
}

const insertStmt = db.prepare(
	`INSERT INTO heal_sessions
	 (id, workflow_id, triggering_run_id, started_at, finished_at, status, diff, test_results_json, new_version_id, agent_transcript_json)
	 VALUES (?, ?, ?, ?, NULL, 'running', NULL, NULL, NULL, NULL)`,
);

const finishStmt = db.prepare(
	`UPDATE heal_sessions
	 SET status = ?, finished_at = ?, diff = ?, test_results_json = ?, new_version_id = ?, agent_transcript_json = ?
	 WHERE id = ?`,
);

const getStmt = db.prepare(`SELECT * FROM heal_sessions WHERE id = ?`);

const listForWorkflowStmt = db.prepare(
	`SELECT * FROM heal_sessions WHERE workflow_id = ? ORDER BY started_at DESC`,
);

const getActiveStmt = db.prepare(
	`SELECT * FROM heal_sessions WHERE workflow_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
);

function parseJson<T>(s: string | null): T | null {
	if (s === null) return null;
	return JSON.parse(s) as T;
}

function rowToHealSession(row: HealSessionRow): HealSession {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		triggeringRunId: row.triggering_run_id,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		status: row.status,
		diff: row.diff,
		testResults: parseJson<HealTestResults>(row.test_results_json),
		newVersionId: row.new_version_id,
		agentTranscript: parseJson<HealAgentTranscriptEntry[]>(row.agent_transcript_json),
	};
}

export interface CreateHealSessionInput {
	workflowId: string;
	triggeringRunId: string;
}

export function createHealSession(input: CreateHealSessionInput): HealSession {
	const id = uuid();
	insertStmt.run(id, input.workflowId, input.triggeringRunId, now());
	const row = getStmt.get(id) as HealSessionRow;
	return rowToHealSession(row);
}

export interface FinishHealSessionInput {
	status: Exclude<HealStatus, "running">;
	diff?: string | null;
	testResults?: HealTestResults | null;
	newVersionId?: string | null;
	agentTranscript?: HealAgentTranscriptEntry[] | null;
}

export function finishHealSession(
	id: string,
	input: FinishHealSessionInput,
): HealSession | null {
	finishStmt.run(
		input.status,
		now(),
		input.diff ?? null,
		input.testResults ? JSON.stringify(input.testResults) : null,
		input.newVersionId ?? null,
		input.agentTranscript ? JSON.stringify(input.agentTranscript) : null,
		id,
	);
	return getHealSession(id);
}

export function getHealSession(id: string): HealSession | null {
	const row = getStmt.get(id) as HealSessionRow | null;
	return row ? rowToHealSession(row) : null;
}

export function listHealSessionsForWorkflow(workflowId: string): HealSession[] {
	const rows = listForWorkflowStmt.all(workflowId) as HealSessionRow[];
	return rows.map(rowToHealSession);
}

export function getActiveHealSession(workflowId: string): HealSession | null {
	const row = getActiveStmt.get(workflowId) as HealSessionRow | null;
	return row ? rowToHealSession(row) : null;
}
