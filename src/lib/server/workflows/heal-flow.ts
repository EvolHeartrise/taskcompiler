import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { healWorkflow } from '$lib/server/agent/roles/heal';
import {
	HEAL_SWEEP_ABORT_THRESHOLD,
	agentEventsToTranscript,
	computeDiff,
	deployHealedVersion
} from '$lib/server/healer/orchestrator';
import { runAgainstEventEphemeral } from '$lib/server/engine/test-runner';
import { getDb } from '$lib/server/db';
import { getEvent, listAllEventsForWorkflow } from '$lib/server/db/queries/events';
import { getWorkflow } from '$lib/server/db/queries/workflows';
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
import type {
	HealTestResultDetail,
	HealTestResults,
	UnhealableCategory
} from '$lib/server/db/types';

// Conservative safety margin below the default 10,000-step-per-instance cap
// (also under the 25,000 configurable ceiling). If a workflow has this many
// historical events the sweep is likely pathological — we still run it, but
// log a warning so ops can intervene before the hard cap is reached.
const SWEEP_EVENT_WARN_THRESHOLD = 5000;

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
// heals for that workflow. Finalization layers, outer-to-inner:
//   1. Per-step try/catch inside runInner (agent-heal / test-sweep framing
//      / deploy-and-replay) writes a step-specific terminal status when a
//      step.do throws after its configured retries exhaust. This is where
//      nearly all legitimate failures land, and it preserves the
//      informative `agent_failed` / `sweep_failed` / `deploy_failed`
//      distinction in the row and the return value. Note: individual
//      per-event sweep steps absorb their own exhaustion into a failed
//      tally entry, so `sweep_failed` here only fires if the framing
//      `list-events-for-sweep` step itself exhausts.
//   2. The outer catch in run() is a safety net for errors that escape
//      outside any step.do (setup code, withLogContext plumbing, etc.).
//      It writes a generic `failed` with a "heal-flow aborted" reason.
//   3. claimHealSlotWithStaleRecovery in the executor handles the harder
//      case of the workflow being killed before any JS runs (worker
//      eviction, queue eviction) by finalizing rows older than 60 min.
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

		// Force workerd to materialize the dispatch-namespace binding in the
		// workflow's main scope before any step.do checkpoint. Without this,
		// second-and-later step.do callbacks that go on to touch
		// env.DISPATCHER (via runAgainstEventEphemeral → invokeDispatcher)
		// can hit a workerd race where the inner work succeeds but the
		// workflow engine never observes the callback resolving — the step
		// sits in Working until its timeout. Originally diagnosed + fixed in
		// 83a65c7, dropped in 103a0ce on the (incorrect) assumption that
		// threading env explicitly through call args was sufficient. It
		// isn't: threading affects JS scope, not workerd's binding-proxy
		// materialization timing. Re-added here with the same rationale.
		void this.env.DISPATCHER;

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
					// Pure safety net: the per-step failure paths inside
					// runInner now own their own finalization (see
					// agent-heal / test-sweep / deploy-and-replay catches).
					// If we still land here the error came from outside a
					// step.do — setup code, withLogContext plumbing, or a
					// NonRetryableError from a step path we haven't explicitly
					// wrapped — so the session can genuinely be orphaned.
					// releaseRunningSlot already no-ops when the row is
					// already terminal, so this is safe unconditionally.
					const message = errorMessage(error);
					log.error(EVENTS.WORKFLOW_RUN_FAILED, {
						error: message,
						reason: 'run() threw outside a handled step, releasing slot'
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

	// Finalizes the heal_session row when the agent-heal step throws after
	// retries exhaust. Preserves any transcript already persisted mid-step:
	// the fixed path calls updateHealSessionTranscript before returning, so
	// a re-entry that made partial progress still has the transcript on the
	// row. Status is `failed` because the agent loop never produced a
	// usable candidate source this time around.
	private async finalizeAgentExhausted(healSessionId: string, reason: string): Promise<void> {
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
				unhealableReason: `agent-heal exhausted retries: ${reason}`
			});
			log.info(EVENTS.HEAL_SLOT_RELEASED, { reason: `agent-heal exhausted: ${reason}` });
		} catch (releaseError) {
			log.error(EVENTS.HEAL_SLOT_RELEASE_FAILED, {
				release_error: errorMessage(releaseError)
			});
		}
	}

	// Finalizes the heal_session row when the test-sweep step throws after
	// retries exhaust. We have a candidateSourceTs so we can still persist a
	// diff for post-mortem inspection even though no sweep results exist.
	private async finalizeSweepExhausted(
		healSessionId: string,
		previousSourceTs: string | null,
		candidateSourceTs: string,
		reason: string
	): Promise<void> {
		try {
			const session = await getHealSession(getDb(this.env), healSessionId);
			if (!session || session.status !== 'running') {
				return;
			}
			await finishHealSession(getDb(this.env), healSessionId, {
				agentTranscript: session.agentTranscript,
				diff: previousSourceTs !== null ? computeDiff(previousSourceTs, candidateSourceTs) : null,
				newVersionId: null,
				status: 'failed',
				testResults: null,
				unhealableReason: `test-sweep exhausted retries: ${reason}`
			});
			log.info(EVENTS.HEAL_SLOT_RELEASED, { reason: `test-sweep exhausted: ${reason}` });
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
		//
		// If step.do throws after its configured retries exhaust, we catch
		// here (rather than at the outer run() boundary) so the heal_session
		// row is finalized with the correct agent_failed status + a specific
		// reason instead of the generic "heal-flow aborted" written by the
		// safety net. Same pattern as the deploy-and-replay catch below.
		let agentSummary: AgentStepSummary;
		try {
			agentSummary = await step.do(
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
		} catch (error) {
			const message = errorMessage(error);
			await this.finalizeAgentExhausted(healSessionId, message);
			return {
				healSessionId,
				reason: `agent-heal exhausted retries: ${message}`,
				status: 'agent_failed'
			};
		}

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

		let sweepResults: HealTestResults & { abortedEarly: boolean };
		try {
			sweepResults = await this.runPerEventSweep(step, {
				candidateSourceTs,
				workflowId
			});
		} catch (error) {
			// Only reached if one of the sweep-framing steps (list-events,
			// fetch-workflow) exhausts its own retries — the per-event steps
			// each absorb their exhaustion into a failed tally entry below.
			const message = errorMessage(error);
			await this.finalizeSweepExhausted(
				healSessionId,
				previousSourceTs,
				candidateSourceTs,
				message
			);
			return {
				healSessionId,
				reason: `test-sweep exhausted retries: ${message}`,
				status: 'sweep_failed'
			};
		}

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

	// Per-event test sweep. Each historical event becomes its own step.do so
	// that (a) a single flaky event's retry doesn't re-run the whole sweep,
	// (b) on Workflow replay the already-passed events are memoized, and
	// (c) the workerd binding-materialization race is bounded to one event
	// at a time. Cloudflare's own guidance is to avoid monolithic steps and
	// to use dynamically-named per-item steps for loop bodies.
	//
	// Deterministic step names: `test-event-${uuid}` is stable across replay
	// because event ids are stable uuids loaded via the list-events-for-sweep
	// step (itself memoized).
	private async runPerEventSweep(
		step: WorkflowStep,
		args: { workflowId: string; candidateSourceTs: string }
	): Promise<HealTestResults & { abortedEarly: boolean }> {
		const { workflowId, candidateSourceTs } = args;
		const env = this.env;

		// We return only event ids (scalar strings) across the step boundary
		// because Event.payload is `unknown` and the Workflow RPC
		// Serializable<T> constraint rejects unknown fields — even though in
		// practice all stored payloads are JSON-derived. Each per-event step
		// re-fetches its own Event + the Workflow row inside its callback,
		// which is cheap (one D1 roundtrip each) and keeps everything
		// memoized at the step granularity.
		const eventIds = await step.do(
			'list-events-for-sweep',
			{ retries: { delay: '5 seconds', limit: 2 }, timeout: '30 seconds' },
			(): Promise<string[]> =>
				withLogContext({ step: 'list-events-for-sweep' }, async () => {
					const evts = await listAllEventsForWorkflow(getDb(env), workflowId);
					return evts.map((e) => e.id);
				})
		);

		log.info(EVENTS.HEAL_SWEEP_START, {
			workflow_id: workflowId,
			total_events: eventIds.length
		});
		if (eventIds.length > SWEEP_EVENT_WARN_THRESHOLD) {
			log.warn(EVENTS.HEAL_SWEEP_EVENT_COUNT_NEAR_CAP, {
				workflow_id: workflowId,
				count: eventIds.length,
				threshold: SWEEP_EVENT_WARN_THRESHOLD
			});
		}

		const details: HealTestResultDetail[] = [];
		let passed = 0;
		let failed = 0;
		let abortedEarly = false;

		for (let i = 0; i < eventIds.length; i++) {
			const eventId = eventIds[i]!;
			log.info(EVENTS.HEAL_SWEEP_EVENT_START, {
				workflow_id: workflowId,
				event_id: eventId,
				event_index: i,
				total_events: eventIds.length
			});

			// Per-event step: retries are bounded, and a retry memoization hit
			// on replay short-circuits straight to the prior outcome.
			let detail: HealTestResultDetail;
			try {
				detail = await step.do(
					`test-event-${eventId}`,
					{ retries: { delay: '5 seconds', limit: 1 }, timeout: '1 minute' },
					(): Promise<HealTestResultDetail> =>
						withLogContext({ step: 'test-event', event_id: eventId }, async () => {
							const db = getDb(env);
							const [event, workflow] = await Promise.all([
								getEvent(db, eventId),
								getWorkflow(db, workflowId)
							]);
							if (!event) {
								throw new Error(`sweep: event disappeared mid-heal: ${eventId}`);
							}
							if (!workflow) {
								throw new Error(`sweep: workflow disappeared mid-heal: ${workflowId}`);
							}
							const res = await runAgainstEventEphemeral(env, candidateSourceTs, event, workflow);
							log.info(EVENTS.HEAL_SWEEP_EVENT_DONE, {
								workflow_id: workflowId,
								event_id: eventId,
								event_index: i,
								ok: res.ok,
								duration_ms: res.durationMs
							});
							const d: HealTestResultDetail = { eventId, ok: res.ok };
							if (!res.ok && res.error) {
								d.error = res.error;
							}
							return d;
						})
				);
			} catch (error) {
				// Step exhausted its retries — classify as a failed tally
				// entry (category: infra) instead of aborting the whole
				// workflow. A single flaky upload/dispatch shouldn't sink a
				// heal that would otherwise pass the other N-1 events.
				const message = errorMessage(error);
				log.warn(EVENTS.HEAL_SWEEP_EVENT_EXHAUSTED, {
					workflow_id: workflowId,
					event_id: eventId,
					event_index: i,
					error: message
				});
				detail = {
					eventId,
					ok: false,
					error: { category: 'infra', message, name: 'SweepStepExhausted' }
				};
			}

			details.push(detail);
			if (detail.ok) {
				passed += 1;
			} else {
				failed += 1;
			}
			if (failed >= HEAL_SWEEP_ABORT_THRESHOLD) {
				abortedEarly = true;
				break;
			}
		}

		log.info(EVENTS.HEAL_SWEEP_END, {
			workflow_id: workflowId,
			passed,
			failed,
			aborted_early: abortedEarly,
			total: eventIds.length
		});

		return {
			abortedEarly,
			details,
			failed,
			passed,
			total: eventIds.length
		};
	}
}
