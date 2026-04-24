import { type DispatchTally, replayFailedEvents } from '$lib/server/engine/replay';
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
	replay: DispatchTally | null;
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

	// Loop bounds guarantee every dp access is in-bounds; the `!` assertions
	// satisfy noUncheckedIndexedAccess, not correctness.
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

// Bails after EARLY_OUT_FAIL_THRESHOLD failures — each iteration deploys,
// invokes, and tears down a temp WFP script. Persists nothing.
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

// The agent transcript is expected to have already been persisted to the
// heal_session row by the workflow's agent step; this function only patches
// in the diff, sweep results, status, and new version id.
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

	// finishHealSession nulls the column when agentTranscript is undefined,
	// so re-read and pass the transcript the agent step already wrote.
	const session = await getHealSessionAgentTranscript(healSessionId);

	await finishHealSession(healSessionId, {
		agentTranscript: session,
		diff,
		newVersionId: version.id,
		status: 'success',
		testResults: sweep
	});

	let replay: DispatchTally | null = null;
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
