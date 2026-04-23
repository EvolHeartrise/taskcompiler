import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { withEnv } from '$lib/server/env';
import { healWorkflow } from '$lib/server/agent/roles/heal';
import {
	agentEventsToTranscript,
	computeDiff,
	deployHealedVersion,
	runHealTestSweep
} from '$lib/server/healer/orchestrator';
import {
	createHealSession,
	finishHealSession,
	updateHealSessionTranscript
} from '$lib/server/db/queries/heal-sessions';
import { getCurrentVersion } from '$lib/server/db/queries/versions';
import type { HealTestResults, UnhealableCategory } from '$lib/server/db/types';

export interface HealWorkflowParams {
	workflowId: string;
	triggeringRunId: string;
}

export type HealWorkflowStatus =
	| 'agent_failed'
	| 'sweep_failed'
	| 'deploy_failed'
	| 'needs_attention'
	| 'success';

export interface HealWorkflowResult {
	status: HealWorkflowStatus;
	healSessionId: string;
	newVersionId?: string;
	reason?: string;
	unhealableCategory?: UnhealableCategory;
}

// Minimal serializable summary of the heal agent's outcome that we pass
// Between Workflow steps. The full HealOutcome contains agent transcript
// Entries with unknown-typed tool args, which violate Rpc.Serializable
// When crossing step boundaries. Transcript + unhealable details get
// Persisted to the heal_session row inside the agent step.
type AgentStepSummary =
	| { kind: 'fixed'; sourceTs: string; summary: string }
	| { kind: 'unhealable'; category: UnhealableCategory; reason: string }
	| { kind: 'failed' | 'abandoned'; reason: string };

export class HealWorkflowFlow extends WorkflowEntrypoint<Env, HealWorkflowParams> {
	async run(
		event: WorkflowEvent<HealWorkflowParams>,
		step: WorkflowStep
	): Promise<HealWorkflowResult> {
		const { workflowId, triggeringRunId } = event.payload;
		const { env } = this;

		// Step 1: open heal_session row. Wrapped in step.do so re-runs of
		// Later steps don't double-insert.
		const healSessionId = await step.do('create-heal-session', async () =>
			withEnv(env, async () => {
				const session = await createHealSession({ triggeringRunId, workflowId });
				return session.id;
			})
		);

		// Step 2: capture the pre-heal source for diff computation in
		// Failure branches. Reads only — safe to memoize.
		const previousSourceTs = await step.do('read-current-source', async () =>
			withEnv(env, async () => {
				const cur = await getCurrentVersion(workflowId);
				return cur?.sourceTs ?? null;
			})
		);

		// Step 3: run the heal agent. Terminal branches (unhealable / failed /
		// Abandoned) finalize the session row inline since we return from
		// This step without doing a sweep/deploy. The transcript is persisted
		// Inside the step so it never has to cross a step boundary.
		const agentSummary = await step.do(
			'agent-heal',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '5 minutes' },
			async (): Promise<AgentStepSummary> =>
				withEnv(env, async () => {
					const outcome = await healWorkflow({ triggeringRunId, workflowId });
					const transcript = agentEventsToTranscript(outcome.agentTranscript);

					if (outcome.kind === 'fixed') {
						// Leave session `running`; downstream steps finalize.
						await updateHealSessionTranscript(healSessionId, transcript);
						return {
							kind: 'fixed',
							sourceTs: outcome.sourceTs,
							summary: outcome.summary
						};
					}

					if (outcome.kind === 'unhealable') {
						await finishHealSession(healSessionId, {
							agentTranscript: transcript,
							diff: null,
							newVersionId: null,
							status: 'needs_attention',
							testResults: null,
							unhealableCategory: outcome.category,
							unhealableReason: outcome.reason
						});
						return {
							category: outcome.category,
							kind: 'unhealable',
							reason: outcome.reason
						};
					}

					// Failed | abandoned
					await finishHealSession(healSessionId, {
						agentTranscript: transcript,
						diff: null,
						newVersionId: null,
						status: outcome.kind,
						testResults: null
					});
					return { kind: outcome.kind, reason: outcome.reason };
				})
		);

		if (agentSummary.kind === 'unhealable') {
			return {
				healSessionId,
				reason: agentSummary.reason,
				status: 'needs_attention',
				unhealableCategory: agentSummary.category
			};
		}

		if (agentSummary.kind !== 'fixed') {
			return {
				healSessionId,
				reason: agentSummary.reason,
				status: 'agent_failed'
			};
		}

		const candidateSourceTs = agentSummary.sourceTs;

		// Step 4: orchestrator-side authoritative test sweep.
		const sweepResults = await step.do(
			'test-sweep',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '10 minutes' },
			async (): Promise<HealTestResults & { abortedEarly: boolean }> =>
				withEnv(env, async () => {
					const sweep = await runHealTestSweep(workflowId, candidateSourceTs);
					return { ...sweep.results, abortedEarly: sweep.abortedEarly };
				})
		);

		if (sweepResults.failed > 0) {
			await step.do('finish-session-sweep-failed', async () =>
				withEnv(env, async () => {
					await finishHealSession(healSessionId, {
						agentTranscript: null,
						diff:
							previousSourceTs !== null ? computeDiff(previousSourceTs, candidateSourceTs) : null,
						newVersionId: null,
						status: 'failed',
						testResults: {
							details: sweepResults.details,
							failed: sweepResults.failed,
							passed: sweepResults.passed,
							total: sweepResults.total
						}
					});
					return { ok: true };
				})
			);
			return {
				healSessionId,
				reason: sweepResults.abortedEarly
					? `sweep aborted early after ${sweepResults.failed} failures`
					: `sweep failed (${sweepResults.failed}/${sweepResults.total})`,
				status: 'sweep_failed'
			};
		}

		// Step 5: deploy + replay. The deploy step pulls the heal_session +
		// HealOutcome again via fresh DB reads inside its callback so no
		// Non-serializable data crosses the step boundary.
		let deployedVersionId: string;
		try {
			deployedVersionId = await step.do(
				'deploy-and-replay',
				{ retries: { delay: '5 seconds', limit: 2 }, timeout: '5 minutes' },
				async (): Promise<string> =>
					withEnv(env, async () => {
						const result = await deployHealedVersion({
							healSessionId,
							sourceTs: candidateSourceTs,
							sweep: {
								details: sweepResults.details,
								failed: sweepResults.failed,
								passed: sweepResults.passed,
								total: sweepResults.total
							},
							triggeringRunId,
							workflowId
						});
						return result.newVersionId;
					})
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await step.do('finish-session-deploy-failed', async () =>
				withEnv(env, async () => {
					await finishHealSession(healSessionId, {
						agentTranscript: null,
						diff:
							previousSourceTs !== null ? computeDiff(previousSourceTs, candidateSourceTs) : null,
						newVersionId: null,
						status: 'failed',
						testResults: {
							details: sweepResults.details,
							failed: sweepResults.failed,
							passed: sweepResults.passed,
							total: sweepResults.total
						}
					});
					return { ok: true };
				})
			);
			return {
				healSessionId,
				reason: `deploy threw: ${message}`,
				status: 'deploy_failed'
			};
		}

		return {
			healSessionId,
			newVersionId: deployedVersionId,
			status: 'success'
		};
	}
}
