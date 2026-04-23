import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { createWorkflow } from '$lib/server/db/queries/workflows';
import type { TriggerType } from '$lib/server/db/types';

export const actions: Actions = {
	default: async (event) => {
		const data = await event.request.formData();
		const name = (data.get('name') ?? '').toString().trim();
		const prompt = (data.get('prompt') ?? '').toString().trim();
		const triggerRaw = (data.get('trigger') ?? '').toString().trim();
		const cronExpr = (data.get('cronExpr') ?? '').toString().trim();

		const values = { cronExpr, name, prompt, trigger: triggerRaw };

		if (!name) {
			return fail(400, { error: 'Name is required.', values });
		}
		if (!prompt) {
			return fail(400, { error: 'Prompt is required.', values });
		}
		if (triggerRaw !== 'webhook' && triggerRaw !== 'cron') {
			return fail(400, { error: 'Trigger must be webhook or cron.', values });
		}
		const trigger = triggerRaw as TriggerType;
		if (trigger === 'cron' && !cronExpr) {
			return fail(400, { error: 'Cron expression is required for cron triggers.', values });
		}

		if (!event.platform) {
			return fail(500, { error: 'Platform bindings unavailable.', values });
		}
		// Project ownership is enforced by /p/[projectId]/+layout.server.ts.
		const workflowId = crypto.randomUUID();
		const { projectId } = event.params;

		try {
			await createWorkflow({
				cronExpr: cronExpr || null,
				id: workflowId,
				name,
				projectId,
				prompt,
				triggerType: trigger
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(500, { error: `Could not create workflow: ${message}`, values });
		}

		try {
			await event.platform.env.GEN_WORKFLOW.create({
				id: `gen-${workflowId}`,
				params: {
					cronExpr: cronExpr || null,
					name,
					prompt,
					triggerType: trigger,
					workflowId
				}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(500, {
				error: `Could not start generation workflow: ${message}`,
				values
			});
		}

		redirect(303, `/p/${projectId}/w/${workflowId}?gen=pending`);
	}
};
