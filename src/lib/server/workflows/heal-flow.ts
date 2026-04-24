import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { healWorkflow } from '$lib/server/agent/roles/heal';
import {
	agentEventsToTranscript,
	computeDiff,
	deployHealedVersion,
	runHealTestSweep
} from '$lib/server/healer/orchestrator';
import { getDb } from '$lib/server/db';
import {
	finishHealSession,
	getHealSession,
	updateHealSessionTranscript
} from '$lib/server/db/queries/heal-sessions';
import { getCurrentVersion } from '$lib/server/db/queries/versions';
import { createLogger } from '$lib/server/log';
import { withLogContext } from '$lib/server/log-context';
import { EVENTS } from '$lib/server/log-events';
import { errorMessage } from '$lib/server/util';
import type { HealTestResults, UnhealableCategory } from '$lib/server/db/types';

const log = createLogger('heal-flow');

export interface HealWorkflowParams {
	workflowId: string;
	triggeringRunId: string;
	// Pre-created by the executor under the partial unique-index lock,
	// so the workflow inherits the slot rather than racing for it.
	healSessionId: string;
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

// Each heal_session row claimed by the executor must reach a terminal
// status — otherwise the partial unique index permanently blocks future
// heals for that workflow. The outer try/catch in run() guarantees that
// any in-process exception releases the slot; claimHealSlotWithStaleRecovery
// in the executor handles the harder case of the workflow being killed
// before any JS runs (worker eviction, queue eviction, etc).
//
// HEAL_AGENT_MAX_TURNS sits well under the runAgent default of 50 to fit
// inside the Workflows per-step CPU budget (5 min configurable on Paid).
// Empirically the model resolves a typical webhook-shape bug in ~10-15
// turns including the harness-driven submit_candidate_source iterations;
// 15 gives modest headroom without inviting 5-min step timeouts.
//
// Followup: split the agent loop across multiple step.do calls (one per
// turn or per N turns) so the per-step budget no longer caps loop length.
const HEAL_AGENT_MAX_TURNS = 15;

export class HealWorkflowFlow extends WorkflowEntrypoint<Env, HealWorkflowParams> {
	async run(
		event: WorkflowEvent<HealWorkflowParams>,
		step: WorkflowStep
	): Promise<HealWorkflowResult> {
		const { workflowId, triggeringRunId, healSessionId } = event.payload;

		return withLogContext(
			{
				context: 'heal-flow',
				heal_session_id: healSessionId,
				triggering_run_id: triggeringRunId,
				workflow_id: workflowId,
				workflow_instance_id: event.instanceId
			},
			async () => {
				log.info(EVENTS.WORKFLOW_RUN_START);
				try {
					const result = await this.runInner(step, {
						healSessionId,
						triggeringRunId,
						workflowId
					});
					log.info(EVENTS.WORKFLOW_RUN_END, {
						status: result.status,
						new_version_id: result.newVersionId
					});
					return result;
				} catch (error) {
					const message = errorMessage(error);
					log.error(EVENTS.WORKFLOW_RUN_FAILED, {
						error: message,
						reason: 'run() threw, releasing slot'
					});
					await this.releaseRunningSlot(healSessionId, message);
					throw error;
				}
			}
		);
	}

	private async releaseRunningSlot(healSessionId: string, reason: string): Promise<void> {
		// Defensive: a stale instance from a previous deploy may have an
		// undefined healSessionId in event.payload. We don't have a row to
		// release in that case, but we also shouldn't crash trying.
		if (typeof healSessionId !== 'string' || healSessionId.length === 0) {
			log.warn(EVENTS.HEAL_SLOT_RELEASE_FAILED, {
				reason: 'missing healSessionId',
				cause: reason
			});
			return;
		}
		try {
			const session = await getHealSession(getDb(this.env), healSessionId);
			if (!session || session.status !== 'running') {
				return;
			}
			await finishHealSession(getDb(this.env), healSessionId, {
				agentTranscript: session.agentTranscript,
				diff: null,
				newVersionId: null,
				status: 'failed',
				testResults: null,
				unhealableReason: `heal-flow aborted: ${reason}`
			});
			log.info(EVENTS.HEAL_SLOT_RELEASED, { reason });
		} catch (releaseError) {
			log.error(EVENTS.HEAL_SLOT_RELEASE_FAILED, {
				release_error: errorMessage(releaseError)
			});
		}
	}

	private async runInner(
		step: WorkflowStep,
		ids: { workflowId: string; triggeringRunId: string; healSessionId: string }
	): Promise<HealWorkflowResult> {
		const { workflowId, triggeringRunId, healSessionId } = ids;
		const env = this.env;

		// Captured pre-heal for diff computation in failure branches.
		const previousSourceTs = await step.do('read-current-source', () =>
			withLogContext({ step: 'read-current-source' }, async () => {
				const cur = await getCurrentVersion(getDb(env), workflowId);
				return cur?.sourceTs ?? null;
			})
		);

		// Terminal branches (unhealable / failed / abandoned) finalize the
		// session row inline — the transcript is persisted here so it never
		// has to cross a step boundary.
		// Step `timeout` is the WALL across all retries (including the
		// `delay` between them); each individual invocation is still bound
		// by Workers' per-call CPU/wall budget (~5 min on Paid). Two retries
		// at 5 min each + 5 s delay fits in the 15-minute envelope.
		const agentSummary = await step.do(
			'agent-heal',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '15 minutes' },
			(): Promise<AgentStepSummary> =>
				withLogContext({ step: 'agent-heal' }, async () => {
					const outcome = await healWorkflow({
						env,
						healSessionId,
						maxTurns: HEAL_AGENT_MAX_TURNS,
						triggeringRunId,
						workflowId
					});
					const transcript = agentEventsToTranscript(outcome.agentTranscript);

					if (outcome.kind === 'fixed') {
						// Leave session `running`; downstream steps finalize it.
						await updateHealSessionTranscript(getDb(env), healSessionId, transcript);
						return {
							kind: 'fixed',
							sourceTs: outcome.sourceTs,
							summary: outcome.summary
						};
					}

					if (outcome.kind === 'unhealable') {
						await finishHealSession(getDb(env), healSessionId, {
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

					await finishHealSession(getDb(env), healSessionId, {
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

		const sweepResults = await step.do(
			'test-sweep',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '10 minutes' },
			(): Promise<HealTestResults & { abortedEarly: boolean }> =>
				withLogContext({ step: 'test-sweep' }, async () => {
					const sweep = await runHealTestSweep(env, workflowId, candidateSourceTs);
					return { ...sweep.results, abortedEarly: sweep.abortedEarly };
				})
		);

		if (sweepResults.failed > 0) {
			await step.do('finish-session-sweep-failed', () =>
				withLogContext({ step: 'finish-session-sweep-failed' }, async () => {
					await finishHealSession(getDb(env), healSessionId, {
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

		// Re-reads heal_session + HealOutcome inside the callback so no
		// non-serializable data crosses the step boundary.
		let deployedVersionId: string;
		try {
			deployedVersionId = await step.do(
				'deploy-and-replay',
				{ retries: { delay: '5 seconds', limit: 2 }, timeout: '5 minutes' },
				(): Promise<string> =>
					withLogContext({ step: 'deploy-and-replay' }, async () => {
						const result = await deployHealedVersion(env, {
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
			const message = errorMessage(error);
			await step.do('finish-session-deploy-failed', () =>
				withLogContext({ step: 'finish-session-deploy-failed' }, async () => {
					await finishHealSession(getDb(env), healSessionId, {
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
