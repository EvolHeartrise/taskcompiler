import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateWorkflow } from '$lib/server/agent/roles/gen';
import { type DispatchTally, backfillWorkflow } from '$lib/server/engine';
import { createLogger } from '$lib/server/log';
import { withLogContext } from '$lib/server/log-context';
import { EVENTS } from '$lib/server/log-events';
import { errorMessage } from '$lib/server/util';

const log = createLogger('gen-flow');

export interface GenWorkflowParams {
	workflowId: string;
	name: string;
	prompt: string;
	backfill?: boolean;
}

export interface GenWorkflowResult {
	workflowId: string;
	versionId: string;
	sourceTs: string;
	backfill?: DispatchTally;
}

export class GenerateWorkflowFlow extends WorkflowEntrypoint<Env, GenWorkflowParams> {
	async run(
		event: WorkflowEvent<GenWorkflowParams>,
		step: WorkflowStep
	): Promise<GenWorkflowResult> {
		return withLogContext(
			{
				context: 'gen-flow',
				workflow_id: event.payload.workflowId,
				workflow_instance_id: event.instanceId
			},
			() => this.runInner(event, step)
		);
	}

	private async runInner(
		event: WorkflowEvent<GenWorkflowParams>,
		step: WorkflowStep
	): Promise<GenWorkflowResult> {
		const params = event.payload;
		const env = this.env;

		log.info(EVENTS.WORKFLOW_RUN_START, { backfill: params.backfill === true });

		const genResult = await step.do(
			'generate',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '5 minutes' },
			() =>
				withLogContext({ step: 'generate' }, async () => {
					const out = await generateWorkflow({
						env,
						name: params.name,
						prompt: params.prompt,
						workflowId: params.workflowId
					});
					return {
						sourceTs: out.sourceTs,
						versionId: out.versionId,
						workflowId: out.workflowId
					};
				})
		);

		if (!params.backfill) {
			log.info(EVENTS.WORKFLOW_RUN_END, { version_id: genResult.versionId });
			return genResult;
		}

		// Best-effort: individual run failures are captured in the DispatchTally,
		// and the entire backfill throwing is tolerated — the workflow is
		// deployed either way.
		const backfill = await step.do(
			'backfill',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '10 minutes' },
			(): Promise<DispatchTally | null> =>
				withLogContext({ step: 'backfill' }, async () => {
					try {
						return await backfillWorkflow(env, params.workflowId);
					} catch (error) {
						log.error(EVENTS.WORKFLOW_STEP_WARNING, {
							error: errorMessage(error),
							reason: 'backfill threw'
						});
						return null;
					}
				})
		);

		log.info(EVENTS.WORKFLOW_RUN_END, {
			version_id: genResult.versionId,
			backfill_ok: backfill?.ok,
			backfill_failed: backfill?.failed
		});
		return backfill ? { ...genResult, backfill } : genResult;
	}
}
