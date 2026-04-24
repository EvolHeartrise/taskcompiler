import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateWorkflow } from '$lib/server/agent/roles/gen';
import { type DispatchTally, backfillWorkflow } from '$lib/server/engine';
import { errorMessage } from '$lib/server/util';

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
		const params = event.payload;

		const genResult = await step.do(
			'generate',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '5 minutes' },
			async () => {
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
			}
		);

		if (!params.backfill) {
			return genResult;
		}

		// Best-effort: individual run failures are captured in the DispatchTally,
		// and the entire backfill throwing is tolerated — the workflow is
		// deployed either way.
		const backfill = await step.do(
			'backfill',
			{ retries: { delay: '5 seconds', limit: 1 }, timeout: '10 minutes' },
			async (): Promise<DispatchTally | null> => {
				try {
					return await backfillWorkflow(params.workflowId);
				} catch (error) {
					console.error('[gen-flow] backfill threw', {
						error: errorMessage(error),
						workflowId: params.workflowId
					});
					return null;
				}
			}
		);

		return backfill ? { ...genResult, backfill } : genResult;
	}
}
