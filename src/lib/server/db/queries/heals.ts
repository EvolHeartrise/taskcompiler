import { getDb, now, uuid } from "../index.ts";
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

export async function createHealSession(
	input: CreateHealSessionInput,
): Promise<HealSession> {
	const id = uuid();
	await getDb()
		.prepare(
			`INSERT INTO heal_sessions
			 (id, workflow_id, triggering_run_id, started_at, finished_at, status, diff, test_results_json, new_version_id, agent_transcript_json)
			 VALUES (?, ?, ?, ?, NULL, 'running', NULL, NULL, NULL, NULL)`,
		)
		.bind(id, input.workflowId, input.triggeringRunId, now())
		.run();
	const row = await getDb()
		.prepare(`SELECT * FROM heal_sessions WHERE id = ?`)
		.bind(id)
		.first<HealSessionRow>();
	if (!row) throw new Error(`createHealSession: row missing after insert (id=${id})`);
	return rowToHealSession(row);
}

export interface FinishHealSessionInput {
	status: Exclude<HealStatus, "running">;
	diff?: string | null;
	testResults?: HealTestResults | null;
	newVersionId?: string | null;
	agentTranscript?: HealAgentTranscriptEntry[] | null;
}

export async function finishHealSession(
	id: string,
	input: FinishHealSessionInput,
): Promise<HealSession | null> {
	await getDb()
		.prepare(
			`UPDATE heal_sessions
			 SET status = ?, finished_at = ?, diff = ?, test_results_json = ?, new_version_id = ?, agent_transcript_json = ?
			 WHERE id = ?`,
		)
		.bind(
			input.status,
			now(),
			input.diff ?? null,
			input.testResults ? JSON.stringify(input.testResults) : null,
			input.newVersionId ?? null,
			input.agentTranscript ? JSON.stringify(input.agentTranscript) : null,
			id,
		)
		.run();
	return getHealSession(id);
}

export async function getHealSession(id: string): Promise<HealSession | null> {
	const row = await getDb()
		.prepare(`SELECT * FROM heal_sessions WHERE id = ?`)
		.bind(id)
		.first<HealSessionRow>();
	return row ? rowToHealSession(row) : null;
}

export async function listHealSessionsForWorkflow(
	workflowId: string,
): Promise<HealSession[]> {
	const res = await getDb()
		.prepare(
			`SELECT * FROM heal_sessions WHERE workflow_id = ? ORDER BY started_at DESC`,
		)
		.bind(workflowId)
		.all<HealSessionRow>();
	return res.results.map(rowToHealSession);
}

export async function getActiveHealSession(
	workflowId: string,
): Promise<HealSession | null> {
	const row = await getDb()
		.prepare(
			`SELECT * FROM heal_sessions WHERE workflow_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
		)
		.bind(workflowId)
		.first<HealSessionRow>();
	return row ? rowToHealSession(row) : null;
}
