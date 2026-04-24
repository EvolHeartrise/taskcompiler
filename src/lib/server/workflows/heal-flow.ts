import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
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
import { errorMessage } from '$lib/server/util';
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

// Serializable summary that crosses Workflow step boundaries. The full
// HealOutcome contains agent transcript entries with unknown-typed tool
// args that violate Rpc.Serializable; transcript + unhealable details are
// persisted to the heal_session row inside the agent step instead.
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

		// See gen-flow.ts for the rationale on this synchronous binding touch —
		// it prevents step.do callbacks from hanging on the first lazy env access.
		void this.env.DISPATCHER;

		const healSessionId = await step.do('create-heal-session', async () => {
			const session = await createHealSession({ triggeringRunId, workflowId });
			return session.id;
		});

		// Captured pre-heal for diff computation in failure branches.
		const previousSourceTs = await step.do('read-current-source', async () => {
			const cur = await getCurrentVersion(workflowId);
			return cur?.sourceTs ?? null;
		});

		// Terminal branches (unhealable / failed / abandoned) finalize the
		// session row inline — the transcript is persisted here so it never
		// has to cross a step boundary.
		const agentSummary = await step.do(
			'agent-heal',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '5 minutes' },
			async (): Promise<AgentStepSummary> => {
				const outcome = await healWorkflow({ triggeringRunId, workflowId });
				const transcript = agentEventsToTranscript(outcome.agentTranscript);

				if (outcome.kind === 'fixed') {
					// Leave session `running`; downstream steps finalize it.
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

				await finishHealSession(healSessionId, {
					agentTranscript: transcript,
					diff: null,
					newVersionId: null,
					status: outcome.kind,
					testResults: null
				});
				return { kind: outcome.kind, reason: outcome.reason };
			}
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

		const sweepResults = await step.do(
			'test-sweep',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '10 minutes' },
			async (): Promise<HealTestResults & { abortedEarly: boolean }> => {
				const sweep = await runHealTestSweep(workflowId, candidateSourceTs);
				return { ...sweep.results, abortedEarly: sweep.abortedEarly };
			}
		);

		if (sweepResults.failed > 0) {
			await step.do('finish-session-sweep-failed', async () => {
				await finishHealSession(healSessionId, {
					agentTranscript: null,
					diff: previousSourceTs !== null ? computeDiff(previousSourceTs, candidateSourceTs) : null,
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
			});
			return {
				healSessionId,
				reason: sweepResults.abortedEarly
					? `sweep aborted early after ${sweepResults.failed} failures`
					: `sweep failed (${sweepResults.failed}/${sweepResults.total})`,
				status: 'sweep_failed'
			};
		}

		// Re-reads heal_session + HealOutcome inside the callback so no
		// non-serializable data crosses the step boundary.
		let deployedVersionId: string;
		try {
			deployedVersionId = await step.do(
				'deploy-and-replay',
				{ retries: { delay: '5 seconds', limit: 2 }, timeout: '5 minutes' },
				async (): Promise<string> => {
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
				}
			);
		} catch (error) {
			const message = errorMessage(error);
			await step.do('finish-session-deploy-failed', async () => {
				await finishHealSession(healSessionId, {
					agentTranscript: null,
					diff: previousSourceTs !== null ? computeDiff(previousSourceTs, candidateSourceTs) : null,
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
			});
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
