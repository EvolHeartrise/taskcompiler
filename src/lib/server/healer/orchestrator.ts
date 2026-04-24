import { type ReplayResult, replayFailedEvents } from '$lib/server/engine/replay';
import { runAgainstEventEphemeral } from '$lib/server/engine/test-runner';
import { getWorkflow } from '$lib/server/db/queries/workflows';
import { createVersion, getCurrentVersion } from '$lib/server/db/queries/versions';
import { listAllEventsForWorkflow } from '$lib/server/db/queries/events';
import { finishHealSession, getHealSession } from '$lib/server/db/queries/heal-sessions';
import { writeVersion } from '$lib/server/workflows-store';
import { errorMessage } from '$lib/server/util';
import type { AgentEvent } from '$lib/server/agent/loop';
import type {
	HealAgentTranscriptEntry,
	HealTestResultDetail,
	HealTestResults
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
			return { message: e.content, role: 'agent', ts: now };
		}
		if (e.type === 'tool_call') {
			return {
				data: { args: e.args, id: e.id },
				message: `call ${e.name}`,
				role: 'tool',
				ts: now
			};
		}
		if (e.type === 'tool_result') {
			return {
				data: { id: e.id, ok: e.ok, output: e.output },
				message: e.ok ? 'tool_result ok' : 'tool_result error',
				role: 'observation',
				ts: now
			};
		}
		return { message: `error: ${e.error}`, role: 'system', ts: now };
	});
}

export function computeDiff(oldSource: string, newSource: string): string {
	const a = oldSource.split('\n');
	const b = newSource.split('\n');
	const m = a.length;
	const n = b.length;

	// LCS table. Loop bounds guarantee every dp access below is in-bounds;
	// The `!` assertions satisfy noUncheckedIndexedAccess, not correctness.
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		Array.from({ length: n + 1 }, () => 0)
	);
	for (let i = m - 1; i >= 0; i--) {
		const row = dp[i]!;
		const nextRow = dp[i + 1]!;
		for (let j = n - 1; j >= 0; j--) {
			if (a[i] === b[j]) {
				row[j] = nextRow[j + 1]! + 1;
			} else {
				row[j] = Math.max(nextRow[j]!, row[j + 1]!);
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
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
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
		if (!res.ok && res.error) {
			detail.error = res.error;
		}
		details.push(detail);
		if (res.ok) {
			passed += 1;
		} else {
			failed += 1;
		}
		if (failed >= EARLY_OUT_FAIL_THRESHOLD) {
			abortedEarly = true;
			break;
		}
	}

	return {
		abortedEarly,
		results: {
			details,
			failed,
			passed,
			total: historicalEvents.length
		}
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
		createdBy: 'heal',
		deployPath,
		healedFromRunId: triggeringRunId,
		parentVersionId: prevCurrent.id,
		setAsCurrent: true,
		sourceTs,
		workflowId
	});

	// Pass undefined for agentTranscript so finishHealSession's UPDATE will
	// Null the column. The transcript was already written by the agent step
	// Via updateHealSessionTranscript and we don't want to drop it.
	// FinishHealSession serializes `null` when transcript is undefined, so
	// We read+pass it explicitly to preserve it.
	const session = await getHealSessionAgentTranscript(healSessionId);

	await finishHealSession(healSessionId, {
		agentTranscript: session,
		diff,
		newVersionId: version.id,
		status: 'success',
		testResults: sweep
	});

	let replay: ReplayResult | null = null;
	try {
		replay = await replayFailedEvents(workflowId);
	} catch (error) {
		console.error('healer.deployHealedVersion: replayFailedEvents threw', {
			error: errorMessage(error),
			workflowId
		});
	}

	return {
		deployPath,
		newVersionId: version.id,
		replay,
		versionNumber: nextVersionNumber
	};
}

async function getHealSessionAgentTranscript(
	healSessionId: string
): Promise<HealAgentTranscriptEntry[] | null> {
	const session = await getHealSession(healSessionId);
	return session?.agentTranscript ?? null;
}
