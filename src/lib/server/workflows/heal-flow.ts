import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { withEnv } from '$lib/server/env';
import { healWorkflow } from '$lib/server/agent/roles/heal';
import type { HealOutcome } from '$lib/server/agent/roles/heal';
import {
	runHealTestSweep,
	deployHealedVersion,
	agentEventsToTranscript,
	computeDiff
} from '$lib/server/healer/orchestrator';
import {
	createHealSession,
	finishHealSession,
	updateHealSessionTranscript
} from '$lib/server/db/queries/heals';
import { getCurrentVersion } from '$lib/server/db/queries/versions';
import type { HealTestResults } from '$lib/server/db/types';

export interface HealWorkflowParams {
	workflowId: string;
	triggeringRunId: string;
}

export type HealWorkflowStatus = 'agent_failed' | 'sweep_failed' | 'deploy_failed' | 'success';

export interface HealWorkflowResult {
	status: HealWorkflowStatus;
	healSessionId: string;
	newVersionId?: string;
	reason?: string;
}

// Minimal serializable summary of the heal agent's outcome that we pass
// between Workflow steps. The full HealOutcome contains `unknown`-typed
// payloads (event payloads, tool args) that violate `Rpc.Serializable`'s
// constraint when returned from `step.do`. The full transcript + test
// details get persisted to the heal_session row inside the agent step
// instead of being shuttled through subsequent steps.
interface AgentStepSummary {
	status: HealOutcome['status'];
	sourceTs: string | null;
	reason: string | null;
}

export class HealWorkflowFlow extends WorkflowEntrypoint<Env, HealWorkflowParams> {
	async run(
		event: WorkflowEvent<HealWorkflowParams>,
		step: WorkflowStep
	): Promise<HealWorkflowResult> {
		const { workflowId, triggeringRunId } = event.payload;
		const env = this.env;

		// Step 1: open heal_session row. Wrapped in step.do so re-runs of
		// later steps don't double-insert.
		const healSessionId = await step.do('create-heal-session', async () =>
			withEnv(env, async () => {
				const session = await createHealSession({ workflowId, triggeringRunId });
				return session.id;
			})
		);

		// Step 2: capture the pre-heal source for diff computation in
		// failure branches. Reads only — safe to memoize.
		const previousSourceTs = await step.do('read-current-source', async () =>
			withEnv(env, async () => {
				const cur = await getCurrentVersion(workflowId);
				return cur?.sourceTs ?? null;
			})
		);

		// Step 3: run the heal agent. On non-success branches we persist
		// the transcript directly to the heal_session row inside the same
		// step so we don't need to ship the full HealOutcome through the
		// step boundary (it contains unknown-typed payloads that violate
		// Rpc.Serializable).
		const agentSummary = await step.do(
			'agent-heal',
			{ retries: { limit: 1, delay: '5 seconds' }, timeout: '5 minutes' },
			async (): Promise<AgentStepSummary> =>
				withEnv(env, async () => {
					const outcome = await healWorkflow({ workflowId, triggeringRunId });
					const transcript = agentEventsToTranscript(outcome.agentTranscript);
					const testResults: HealTestResults = {
						total: outcome.testResults.total,
						passed: outcome.testResults.passed,
						failed: outcome.testResults.failed,
						details: outcome.testResults.details.map((d) => ({
							eventId: d.eventId,
							ok: d.ok,
							...(d.error ? { error: d.error } : {})
						}))
					};
					if (outcome.status !== 'success' || !outcome.sourceTs) {
						// Terminal — finish the session row here; the workflow returns
						// after this step.
						await finishHealSession(healSessionId, {
							status: outcome.status === 'success' ? 'failed' : outcome.status,
							agentTranscript: transcript,
							testResults,
							diff: null,
							newVersionId: null
						});
						return {
							status: outcome.status,
							sourceTs: null,
							reason: outcome.reason ?? `agent stopped with status=${outcome.status}`
						};
					}
					// Success — persist the transcript now, but leave the session
					// row in `running` state. Later steps overwrite the row when
					// they finalize (success or fail).
					await updateHealSessionTranscript(healSessionId, transcript);
					return {
						status: 'success',
						sourceTs: outcome.sourceTs,
						reason: outcome.reason ?? null
					};
				})
		);

		if (agentSummary.status !== 'success' || !agentSummary.sourceTs) {
			return {
				status: 'agent_failed',
				healSessionId,
				reason: agentSummary.reason ?? `agent stopped with status=${agentSummary.status}`
			};
		}

		const candidateSourceTs = agentSummary.sourceTs;

		// Step 4: orchestrator-side authoritative test sweep.
		const sweepResults = await step.do(
			'test-sweep',
			{ retries: { limit: 1, delay: '5 seconds' }, timeout: '10 minutes' },
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
						status: 'failed',
						agentTranscript: null,
						testResults: {
							total: sweepResults.total,
							passed: sweepResults.passed,
							failed: sweepResults.failed,
							details: sweepResults.details
						},
						diff:
							previousSourceTs !== null ? computeDiff(previousSourceTs, candidateSourceTs) : null,
						newVersionId: null
					});
					return { ok: true };
				})
			);
			return {
				status: 'sweep_failed',
				healSessionId,
				reason: sweepResults.abortedEarly
					? `sweep aborted early after ${sweepResults.failed} failures`
					: `sweep failed (${sweepResults.failed}/${sweepResults.total})`
			};
		}

		// Step 5: deploy + replay. The deploy step pulls the heal_session +
		// healOutcome again via fresh DB reads inside its callback so no
		// non-serializable data crosses the step boundary.
		let deployedVersionId: string;
		try {
			deployedVersionId = await step.do(
				'deploy-and-replay',
				{ retries: { limit: 2, delay: '5 seconds' }, timeout: '5 minutes' },
				async (): Promise<string> =>
					withEnv(env, async () => {
						const result = await deployHealedVersion({
							workflowId,
							sourceTs: candidateSourceTs,
							triggeringRunId,
							healSessionId,
							sweep: {
								total: sweepResults.total,
								passed: sweepResults.passed,
								failed: sweepResults.failed,
								details: sweepResults.details
							}
						});
						return result.newVersionId;
					})
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await step.do('finish-session-deploy-failed', async () =>
				withEnv(env, async () => {
					await finishHealSession(healSessionId, {
						status: 'failed',
						agentTranscript: null,
						testResults: {
							total: sweepResults.total,
							passed: sweepResults.passed,
							failed: sweepResults.failed,
							details: sweepResults.details
						},
						diff:
							previousSourceTs !== null ? computeDiff(previousSourceTs, candidateSourceTs) : null,
						newVersionId: null
					});
					return { ok: true };
				})
			);
			return {
				status: 'deploy_failed',
				healSessionId,
				reason: `deploy threw: ${message}`
			};
		}

		return {
			status: 'success',
			healSessionId,
			newVersionId: deployedVersionId
		};
	}
}
