import { type DispatchTally, replayFailedEvents } from '$lib/server/engine/replay';
import { getDb } from '$lib/server/db';
import { createVersion, getCurrentVersion } from '$lib/server/db/queries/versions';
import { finishHealSession, getHealSession } from '$lib/server/db/queries/heal-sessions';
import { writeVersion } from '$lib/server/workflows-store';
import { createLogger } from '$lib/server/log';
import { EVENTS } from '$lib/server/log-events';
import { errorMessage } from '$lib/server/util';

const log = createLogger('healer');
import type { AgentEvent } from '$lib/server/agent/loop';
import type { HealAgentTranscriptEntry, HealTestResults } from '$lib/server/db/types';

// Exported so heal-flow.ts can preserve the same abort magnitude when the
// sweep now runs as a loop of per-event step.do calls at the Workflow top
// level.
export const HEAL_SWEEP_ABORT_THRESHOLD = 5;

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

// The agent transcript is expected to have already been persisted to the
// heal_session row by the workflow's agent step; this function only patches
// in the diff, sweep results, status, and new version id.
export async function deployHealedVersion(
	env: Env,
	args: {
		workflowId: string;
		sourceTs: string;
		triggeringRunId: string;
		healSessionId: string;
		sweep: HealTestResults;
	}
): Promise<DeployHealedVersionResult> {
	const { workflowId, sourceTs, triggeringRunId, healSessionId, sweep } = args;
	const db = getDb(env);

	const prevCurrent = await getCurrentVersion(db, workflowId);
	if (!prevCurrent) {
		throw new Error(`deployHealedVersion: workflow has no current version: ${workflowId}`);
	}

	const diff = computeDiff(prevCurrent.sourceTs, sourceTs);
	const nextVersionNumber = prevCurrent.version + 1;

	const deployPath = await writeVersion(env, workflowId, nextVersionNumber, sourceTs);

	const version = await createVersion(db, {
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
	const session = await getHealSessionAgentTranscript(env, healSessionId);

	await finishHealSession(db, healSessionId, {
		agentTranscript: session,
		diff,
		newVersionId: version.id,
		status: 'success',
		testResults: sweep
	});

	let replay: DispatchTally | null = null;
	try {
		replay = await replayFailedEvents(env, workflowId);
	} catch (error) {
		log.error(EVENTS.DISPATCH_TALLY_THREW, {
			error: errorMessage(error),
			workflow_id: workflowId,
			source: 'deployHealedVersion.replayFailedEvents'
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
	env: Env,
	healSessionId: string
): Promise<HealAgentTranscriptEntry[] | null> {
	const session = await getHealSession(getDb(env), healSessionId);
	return session?.agentTranscript ?? null;
}
