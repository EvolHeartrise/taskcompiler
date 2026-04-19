import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { withEnv } from '$lib/server/env';
import { generateWorkflow } from '$lib/server/agent/roles/gen';
import type { TriggerType } from '$lib/server/db/types';

export interface GenWorkflowParams {
	workflowId: string;
	name: string;
	prompt: string;
	triggerType: TriggerType;
	cronExpr?: string | null;
}

export interface GenWorkflowResult {
	workflowId: string;
	versionId: string;
	sourceTs: string;
}

export class GenerateWorkflowFlow extends WorkflowEntrypoint<Env, GenWorkflowParams> {
	async run(
		event: WorkflowEvent<GenWorkflowParams>,
		step: WorkflowStep
	): Promise<GenWorkflowResult> {
		const params = event.payload;
		return withEnv(this.env, async () =>
			step.do(
				'generate',
				{ retries: { limit: 1, delay: '5 seconds' }, timeout: '5 minutes' },
				async () => {
					const out = await generateWorkflow({
						name: params.name,
						prompt: params.prompt,
						triggerType: params.triggerType,
						cronExpr: params.cronExpr ?? null,
						workflowIdOverride: params.workflowId
					});
					return {
						workflowId: out.workflowId,
						versionId: out.versionId,
						sourceTs: out.sourceTs
					};
				}
			)
		);
	}
}
