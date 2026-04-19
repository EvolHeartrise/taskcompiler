import { setRunFailedHook, type RunFailedContext } from "$lib/server/engine/hooks";
import { replayFailedEvents } from "$lib/server/engine/replay";
import { runAgainstEventEphemeral } from "$lib/server/engine/test-runner";
import { getWorkflow } from "$lib/server/db/queries/workflows";
import { getCurrentVersion, createVersion } from "$lib/server/db/queries/versions";
import { listAllEventsForWorkflow } from "$lib/server/db/queries/events";
import {
	createHealSession,
	finishHealSession,
	getActiveHealSession,
} from "$lib/server/db/queries/heals";
import { writeVersion } from "$lib/server/workflows-store";
import { healWorkflow, type HealOutcome } from "$lib/server/agent/roles/heal";
import type { AgentEvent } from "$lib/server/agent";
import type {
	HealAgentTranscriptEntry,
	HealTestResults,
	HealTestResultDetail,
} from "$lib/server/db/types";

export interface HealRunSummary {
	sessionId: string;
	outcome: HealOutcome;
}

export function wireHealer(): void {
	setRunFailedHook(handleRunFailure);
}

function agentEventsToTranscript(events: AgentEvent[]): HealAgentTranscriptEntry[] {
	const now = Date.now();
	return events.map((e): HealAgentTranscriptEntry => {
		if (e.type === "assistant_message") {
			return { ts: now, role: "agent", message: e.content };
		}
		if (e.type === "tool_call") {
			return {
				ts: now,
				role: "tool",
				message: `call ${e.name}`,
				data: { id: e.id, args: e.args },
			};
		}
		if (e.type === "tool_result") {
			return {
				ts: now,
				role: "observation",
				message: e.ok ? "tool_result ok" : "tool_result error",
				data: { id: e.id, ok: e.ok, output: e.output },
			};
		}
		return { ts: now, role: "system", message: `error: ${e.error}` };
	});
}

export function computeDiff(oldSource: string, newSource: string): string {
	const a = oldSource.split("\n");
	const b = newSource.split("\n");
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

	const lines: string[] = ["--- old", "+++ new"];
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
	return lines.join("\n");
}

function outcomeTestResultsToDb(outcome: HealOutcome): HealTestResults {
	const details: HealTestResultDetail[] = outcome.testResults.details.map((d) => {
		const out: HealTestResultDetail = { eventId: d.eventId, ok: d.ok };
		if (d.error) out.error = d.error;
		return out;
	});
	return {
		total: outcome.testResults.total,
		passed: outcome.testResults.passed,
		failed: outcome.testResults.failed,
		details,
	};
}

export async function handleRunFailure(evt: RunFailedContext): Promise<void> {
	const { workflowId, runId: triggeringRunId } = evt;

	const existing = await getActiveHealSession(workflowId);
	if (existing) {
		console.log("healer: skipping, active heal session exists", {
			workflowId,
			sessionId: existing.id,
		});
		return;
	}

	const workflow = await getWorkflow(workflowId);
	if (!workflow) {
		console.error("healer: workflow not found", { workflowId });
		return;
	}

	const prevCurrent = await getCurrentVersion(workflowId);
	if (!prevCurrent) {
		console.error("healer: workflow has no current version", { workflowId });
		return;
	}

	const session = await createHealSession({ workflowId, triggeringRunId });

	const agentEvents: AgentEvent[] = [];

	let outcome: HealOutcome;
	try {
		outcome = await healWorkflow({
			workflowId,
			triggeringRunId,
			onEvent: (e) => {
				agentEvents.push(e);
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("healer: healWorkflow threw", { workflowId, error: message });
		await finishHealSession(session.id, {
			status: "failed",
			agentTranscript: agentEventsToTranscript(agentEvents),
			testResults: { total: 0, passed: 0, failed: 0, details: [] },
			diff: null,
			newVersionId: null,
		});
		return;
	}

	if (outcome.status !== "success" || !outcome.sourceTs) {
		await finishHealSession(session.id, {
			status: outcome.status === "success" ? "failed" : outcome.status,
			agentTranscript: agentEventsToTranscript(outcome.agentTranscript),
			testResults: outcomeTestResultsToDb(outcome),
			diff: outcome.diff ?? null,
			newVersionId: null,
		});
		console.log("healer: agent did not produce a fix", {
			workflowId,
			status: outcome.status,
			reason: outcome.reason,
		});
		return;
	}

	// Orchestrator-side validation gate: run candidate against ALL historical events.
	// Each iteration deploys + invokes + tears down a temp WFP script, so for workflows
	// with many events the sweep can take many seconds. Bail early when the candidate
	// is obviously broken to save orchestrator time.
	const EARLY_OUT_FAIL_THRESHOLD = 5;
	const historicalEvents = await listAllEventsForWorkflow(workflowId);
	const details: HealTestResultDetail[] = [];
	let passed = 0;
	let failed = 0;
	let abortedEarly = false;
	for (const event of historicalEvents) {
		const res = await runAgainstEventEphemeral(outcome.sourceTs, event, workflow);
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

	const sweep: HealTestResults = {
		total: historicalEvents.length,
		passed,
		failed,
		details,
	};

	if (abortedEarly) {
		await finishHealSession(session.id, {
			status: "failed",
			agentTranscript: agentEventsToTranscript(outcome.agentTranscript),
			testResults: sweep,
			diff: computeDiff(prevCurrent.sourceTs, outcome.sourceTs),
			newVersionId: null,
		});
		console.log("healer: validation sweep aborted early after threshold failures", {
			workflowId,
			passed,
			failed,
			tested: details.length,
			total: historicalEvents.length,
			threshold: EARLY_OUT_FAIL_THRESHOLD,
		});
		return;
	}

	const oldSource = prevCurrent.sourceTs;
	const diff = computeDiff(oldSource, outcome.sourceTs);

	if (failed > 0) {
		await finishHealSession(session.id, {
			status: "failed",
			agentTranscript: agentEventsToTranscript(outcome.agentTranscript),
			testResults: sweep,
			diff,
			newVersionId: null,
		});
		console.log("healer: validation sweep failed, not deploying", {
			workflowId,
			passed,
			failed,
			total: historicalEvents.length,
		});
		return;
	}

	// Green sweep — upload the new version's user Worker, then record it as current.
	const nextVersionNumber = prevCurrent.version + 1;
	let deployPath: string;
	try {
		deployPath = await writeVersion(workflowId, nextVersionNumber, outcome.sourceTs);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("healer: WFP upload failed; not promoting candidate", {
			workflowId,
			error: message,
		});
		await finishHealSession(session.id, {
			status: "failed",
			agentTranscript: agentEventsToTranscript(outcome.agentTranscript),
			testResults: sweep,
			diff,
			newVersionId: null,
		});
		return;
	}

	try {
		const version = await createVersion({
			workflowId,
			sourceTs: outcome.sourceTs,
			deployPath,
			createdBy: "heal",
			parentVersionId: prevCurrent.id,
			healedFromRunId: triggeringRunId,
			setAsCurrent: true,
		});

		await finishHealSession(session.id, {
			status: "success",
			agentTranscript: agentEventsToTranscript(outcome.agentTranscript),
			testResults: sweep,
			diff,
			newVersionId: version.id,
		});

		console.log("healer: deployed new version", {
			workflowId,
			newVersionId: version.id,
			versionNumber: nextVersionNumber,
			deployPath,
		});

		// TODO(M3+): delete the previous version's WFP script via
		// deleteWorkflowVersion(prevCurrent.deployPath) once we have a safe way to
		// avoid racing in-flight invocations against the old script. For M2 we leave
		// stale scripts in the dispatch namespace — they're cheap and cleanup is a
		// future concern.

		try {
			const replay = await replayFailedEvents(workflowId);
			console.log("healer: replayed failed events", {
				workflowId,
				attempted: replay.attempted,
				ok: replay.ok,
				failed: replay.failed,
			});
		} catch (err) {
			console.error("healer: replayFailedEvents threw", {
				workflowId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("healer: post-upload deploy step threw", {
			workflowId,
			error: message,
		});
		await finishHealSession(session.id, {
			status: "failed",
			agentTranscript: agentEventsToTranscript(outcome.agentTranscript),
			testResults: sweep,
			diff,
			newVersionId: null,
		});
	}
}
