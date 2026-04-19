import { setRunFailedHook, type RunFailedContext } from "$lib/server/engine/hooks";
import { invalidateVersion } from "$lib/server/engine/loader";
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
	const historicalEvents = await listAllEventsForWorkflow(workflowId);
	const details: HealTestResultDetail[] = [];
	let passed = 0;
	let failed = 0;
	for (const event of historicalEvents) {
		const res = await runAgainstEventEphemeral(outcome.sourceTs, event, workflow);
		const detail: HealTestResultDetail = { eventId: event.id, ok: res.ok };
		if (!res.ok && res.error) detail.error = res.error;
		details.push(detail);
		if (res.ok) passed += 1;
		else failed += 1;
	}

	const sweep: HealTestResults = {
		total: historicalEvents.length,
		passed,
		failed,
		details,
	};

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

	// Green sweep — deploy a new version.
	try {
		const nextVersionNumber = prevCurrent.version + 1;
		const deployPath = await writeVersion(
			workflowId,
			nextVersionNumber,
			outcome.sourceTs,
		);
		const version = await createVersion({
			workflowId,
			sourceTs: outcome.sourceTs,
			deployPath,
			createdBy: "heal",
			parentVersionId: prevCurrent.id,
			healedFromRunId: triggeringRunId,
			setAsCurrent: true,
		});

		invalidateVersion(prevCurrent.id);

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
		});

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
		console.error("healer: deploy threw", { workflowId, error: message });
		await finishHealSession(session.id, {
			status: "failed",
			agentTranscript: agentEventsToTranscript(outcome.agentTranscript),
			testResults: sweep,
			diff,
			newVersionId: null,
		});
	}
}
