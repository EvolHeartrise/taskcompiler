import { getDb, now, parseJson, uuid } from '../index.ts';
import type {
	HealAgentTranscriptEntry,
	HealSession,
	HealStatus,
	HealTestResults,
	UnhealableCategory
} from '../types.ts';

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
	unhealable_category: UnhealableCategory | null;
	unhealable_reason: string | null;
	resolved_at: number | null;
}

function rowToHealSession(row: HealSessionRow): HealSession {
	return {
		agentTranscript: parseJson<HealAgentTranscriptEntry[]>(row.agent_transcript_json),
		diff: row.diff,
		finishedAt: row.finished_at,
		id: row.id,
		newVersionId: row.new_version_id,
		resolvedAt: row.resolved_at,
		startedAt: row.started_at,
		status: row.status,
		testResults: parseJson<HealTestResults>(row.test_results_json),
		triggeringRunId: row.triggering_run_id,
		unhealableCategory: row.unhealable_category,
		unhealableReason: row.unhealable_reason,
		workflowId: row.workflow_id
	};
}

export interface CreateHealSessionInput {
	workflowId: string;
	triggeringRunId: string;
}

export async function createHealSession(input: CreateHealSessionInput): Promise<HealSession> {
	const id = uuid();
	await getDb()
		.prepare(
			`INSERT INTO heal_sessions
			 (id, workflow_id, triggering_run_id, started_at, finished_at, status, diff, test_results_json, new_version_id, agent_transcript_json, unhealable_category, unhealable_reason, resolved_at)
			 VALUES (?, ?, ?, ?, NULL, 'running', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
		)
		.bind(id, input.workflowId, input.triggeringRunId, now())
		.run();
	const row = await getDb()
		.prepare(`SELECT * FROM heal_sessions WHERE id = ?`)
		.bind(id)
		.first<HealSessionRow>();
	if (!row) {
		throw new Error(`createHealSession: row missing after insert (id=${id})`);
	}
	return rowToHealSession(row);
}

export interface FinishHealSessionInput {
	status: Exclude<HealStatus, 'running' | 'resolved'>;
	diff?: string | null;
	testResults?: HealTestResults | null;
	newVersionId?: string | null;
	agentTranscript?: HealAgentTranscriptEntry[] | null;
	unhealableCategory?: UnhealableCategory | null;
	unhealableReason?: string | null;
}

export async function finishHealSession(
	id: string,
	input: FinishHealSessionInput
): Promise<HealSession | null> {
	await getDb()
		.prepare(
			`UPDATE heal_sessions
			 SET status = ?, finished_at = ?, diff = ?, test_results_json = ?, new_version_id = ?, agent_transcript_json = ?, unhealable_category = ?, unhealable_reason = ?
			 WHERE id = ?`
		)
		.bind(
			input.status,
			now(),
			input.diff ?? null,
			input.testResults ? JSON.stringify(input.testResults) : null,
			input.newVersionId ?? null,
			input.agentTranscript ? JSON.stringify(input.agentTranscript) : null,
			input.unhealableCategory ?? null,
			input.unhealableReason ?? null,
			id
		)
		.run();
	return getHealSession(id);
}

export async function updateHealSessionTranscript(
	id: string,
	transcript: HealAgentTranscriptEntry[]
): Promise<void> {
	await getDb()
		.prepare(`UPDATE heal_sessions SET agent_transcript_json = ? WHERE id = ?`)
		.bind(JSON.stringify(transcript), id)
		.run();
}

export async function markHealSessionResolved(id: string): Promise<HealSession | null> {
	await getDb()
		.prepare(`UPDATE heal_sessions SET status = 'resolved', resolved_at = ? WHERE id = ?`)
		.bind(now(), id)
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

export async function listHealSessionsForWorkflow(workflowId: string): Promise<HealSession[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM heal_sessions WHERE workflow_id = ? ORDER BY started_at DESC`)
		.bind(workflowId)
		.all<HealSessionRow>();
	return res.results.map(rowToHealSession);
}

export async function getActiveHealSession(workflowId: string): Promise<HealSession | null> {
	const row = await getDb()
		.prepare(
			`SELECT * FROM heal_sessions WHERE workflow_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`
		)
		.bind(workflowId)
		.first<HealSessionRow>();
	return row ? rowToHealSession(row) : null;
}

export async function getOpenNeedsAttentionSession(
	workflowId: string
): Promise<HealSession | null> {
	const row = await getDb()
		.prepare(
			`SELECT * FROM heal_sessions WHERE workflow_id = ? AND status = 'needs_attention' ORDER BY started_at DESC LIMIT 1`
		)
		.bind(workflowId)
		.first<HealSessionRow>();
	return row ? rowToHealSession(row) : null;
}
