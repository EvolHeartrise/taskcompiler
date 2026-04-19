import { replayFailedEvents, type ReplayResult } from '$lib/server/engine/replay';
import { runAgainstEventEphemeral } from '$lib/server/engine/test-runner';
import { getWorkflow } from '$lib/server/db/queries/workflows';
import { getCurrentVersion, createVersion } from '$lib/server/db/queries/versions';
import { listAllEventsForWorkflow } from '$lib/server/db/queries/events';
import { finishHealSession, getHealSession } from '$lib/server/db/queries/heals';
import { writeVersion } from '$lib/server/workflows-store';
import type { HealOutcome } from '$lib/server/agent/roles/heal';
import type { AgentEvent } from '$lib/server/agent';
import type {
	HealAgentTranscriptEntry,
	HealTestResults,
	HealTestResultDetail
} from '$lib/server/db/types';

const EARLY_OUT_FAIL_THRESHOLD = 5;

export interface HealSweepResult {
	results: HealTestResults;
	abortedEarly: boolean;
}

export interface DeployHealedVersionResult {
	newVersionId: string;
	versionNumber: number;
	deployPath: string;
	replay: ReplayResult | null;
}

export function agentEventsToTranscript(events: AgentEvent[]): HealAgentTranscriptEntry[] {
	const now = Date.now();
	return events.map((e): HealAgentTranscriptEntry => {
		if (e.type === 'assistant_message') {
			return { ts: now, role: 'agent', message: e.content };
		}
		if (e.type === 'tool_call') {
			return {
				ts: now,
				role: 'tool',
				message: `call ${e.name}`,
				data: { id: e.id, args: e.args }
			};
		}
		if (e.type === 'tool_result') {
			return {
				ts: now,
				role: 'observation',
				message: e.ok ? 'tool_result ok' : 'tool_result error',
				data: { id: e.id, ok: e.ok, output: e.output }
			};
		}
		return { ts: now, role: 'system', message: `error: ${e.error}` };
	});
}

export function computeDiff(oldSource: string, newSource: string): string {
	const a = oldSource.split('\n');
	const b = newSource.split('\n');
	const m = a.length;
	const n = b.length;

	// LCS table
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (a[i] === b[j]) {
				dp[i][j] = dp[i + 1][j + 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}

	const lines: string[] = ['--- old', '+++ new'];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			lines.push(` ${a[i]}`);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			lines.push(`-${a[i]}`);
			i++;
		} else {
			lines.push(`+${b[j]}`);
			j++;
		}
	}
	while (i < m) {
		lines.push(`-${a[i]}`);
		i++;
	}
	while (j < n) {
		lines.push(`+${b[j]}`);
		j++;
	}
	return lines.join('\n');
}

export function outcomeTestResultsToDb(outcome: HealOutcome): HealTestResults {
	const details: HealTestResultDetail[] = outcome.testResults.details.map((d) => {
		const out: HealTestResultDetail = { eventId: d.eventId, ok: d.ok };
		if (d.error) out.error = d.error;
		return out;
	});
	return {
		total: outcome.testResults.total,
		passed: outcome.testResults.passed,
		failed: outcome.testResults.failed,
		details
	};
}

/**
 * Authoritative test sweep: run a candidate source against every historical
 * event for the workflow. Bails early after EARLY_OUT_FAIL_THRESHOLD failures
 * (each iteration deploys/invokes/tears down a temp WFP script).
 *
 * Persists nothing; the caller decides what to do with the result.
 */
export async function runHealTestSweep(
	workflowId: string,
	sourceTs: string
): Promise<HealSweepResult> {
	const workflow = await getWorkflow(workflowId);
	if (!workflow) {
		throw new Error(`runHealTestSweep: workflow not found: ${workflowId}`);
	}

	const historicalEvents = await listAllEventsForWorkflow(workflowId);
	const details: HealTestResultDetail[] = [];
	let passed = 0;
	let failed = 0;
	let abortedEarly = false;

	for (const event of historicalEvents) {
		const res = await runAgainstEventEphemeral(sourceTs, event, workflow);
		const detail: HealTestResultDetail = { eventId: event.id, ok: res.ok };
		if (!res.ok && res.error) detail.error = res.error;
		details.push(detail);
		if (res.ok) passed += 1;
		else failed += 1;
		if (failed >= EARLY_OUT_FAIL_THRESHOLD) {
			abortedEarly = true;
			break;
		}
	}

	return {
		results: {
			total: historicalEvents.length,
			passed,
			failed,
			details
		},
		abortedEarly
	};
}

/**
 * Promote a healed candidate: upload the new WFP script, create the version
 * row, mark the heal session success, and replay previously-failed events.
 *
 * The agent transcript is expected to have already been persisted to the
 * heal_session row (by the workflow's agent step); this function only
 * patches in the diff, sweep results, status, and new version id.
 */
export async function deployHealedVersion(args: {
	workflowId: string;
	sourceTs: string;
	triggeringRunId: string;
	healSessionId: string;
	sweep: HealTestResults;
}): Promise<DeployHealedVersionResult> {
	const { workflowId, sourceTs, triggeringRunId, healSessionId, sweep } = args;

	const prevCurrent = await getCurrentVersion(workflowId);
	if (!prevCurrent) {
		throw new Error(`deployHealedVersion: workflow has no current version: ${workflowId}`);
	}

	const diff = computeDiff(prevCurrent.sourceTs, sourceTs);
	const nextVersionNumber = prevCurrent.version + 1;

	const deployPath = await writeVersion(workflowId, nextVersionNumber, sourceTs);

	const version = await createVersion({
		workflowId,
		sourceTs,
		deployPath,
		createdBy: 'heal',
		parentVersionId: prevCurrent.id,
		healedFromRunId: triggeringRunId,
		setAsCurrent: true
	});

	// Pass undefined for agentTranscript so finishHealSession's UPDATE will
	// null the column. The transcript was already written by the agent step
	// via updateHealSessionTranscript and we don't want to drop it.
	// finishHealSession serializes `null` when transcript is undefined, so
	// we read+pass it explicitly to preserve it.
	const session = await getHealSessionAgentTranscript(healSessionId);

	await finishHealSession(healSessionId, {
		status: 'success',
		agentTranscript: session,
		testResults: sweep,
		diff,
		newVersionId: version.id
	});

	let replay: ReplayResult | null = null;
	try {
		replay = await replayFailedEvents(workflowId);
	} catch (err) {
		console.error('healer.deployHealedVersion: replayFailedEvents threw', {
			workflowId,
			error: err instanceof Error ? err.message : String(err)
		});
	}

	return {
		newVersionId: version.id,
		versionNumber: nextVersionNumber,
		deployPath,
		replay
	};
}

async function getHealSessionAgentTranscript(
	healSessionId: string
): Promise<HealAgentTranscriptEntry[] | null> {
	const session = await getHealSession(healSessionId);
	return session?.agentTranscript ?? null;
}
