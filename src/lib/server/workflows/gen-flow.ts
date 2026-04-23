import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { withEnv } from '$lib/server/env';
import { generateWorkflow } from '$lib/server/agent/roles/gen';
import { type BackfillResult, backfillWorkflow } from '$lib/server/engine';

export interface GenWorkflowParams {
	workflowId: string;
	name: string;
	prompt: string;
	/**
	 * If true, after generation succeeds, run the new workflow against every
	 * historical event on its event source as is_replay runs. Useful for
	 * graceful-handover / A/B scenarios where a new workflow is attached to a
	 * source with existing events.
	 */
	backfill?: boolean;
}

export interface GenWorkflowResult {
	workflowId: string;
	versionId: string;
	sourceTs: string;
	backfill?: BackfillResult;
}

export class GenerateWorkflowFlow extends WorkflowEntrypoint<Env, GenWorkflowParams> {
	async run(
		event: WorkflowEvent<GenWorkflowParams>,
		step: WorkflowStep
	): Promise<GenWorkflowResult> {
		const params = event.payload;
		const { env } = this;

		const genResult = await step.do(
			'generate',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '5 minutes' },
			async () =>
				withEnv(env, async () => {
					const out = await generateWorkflow({
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
			return genResult;
		}

		// Backfill is best-effort — individual run failures are captured in the
		// BackfillResult and do not abort the workflow. We also tolerate the
		// Entire backfill throwing: the workflow is deployed either way.
		const backfill = await step.do(
			'backfill',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '10 minutes' },
			async (): Promise<BackfillResult | null> =>
				withEnv(env, async () => {
					try {
						return await backfillWorkflow(params.workflowId);
					} catch (error) {
						console.error('[gen-flow] backfill threw', {
							error: error instanceof Error ? error.message : String(error),
							workflowId: params.workflowId
						});
						return null;
					}
				})
		);

		return backfill ? { ...genResult, backfill } : genResult;
	}
}
