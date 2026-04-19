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

		const values = { name, prompt, trigger: triggerRaw, cronExpr };

		if (!name) return fail(400, { values, error: 'Name is required.' });
		if (!prompt) return fail(400, { values, error: 'Prompt is required.' });
		if (triggerRaw !== 'webhook' && triggerRaw !== 'cron' && triggerRaw !== 'both') {
			return fail(400, { values, error: 'Trigger must be webhook, cron, or both.' });
		}
		const trigger = triggerRaw as TriggerType;
		if ((trigger === 'cron' || trigger === 'both') && !cronExpr) {
			return fail(400, { values, error: 'Cron expression is required for cron triggers.' });
		}

		if (!event.platform) {
			return fail(500, { values, error: 'Platform bindings unavailable.' });
		}

		const workflowId = crypto.randomUUID();

		try {
			await createWorkflow({
				id: workflowId,
				name,
				prompt,
				triggerType: trigger,
				cronExpr: cronExpr || null
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return fail(500, { values, error: `Could not create workflow: ${message}` });
		}

		try {
			await event.platform.env.GEN_WORKFLOW.create({
				id: `gen-${workflowId}`,
				params: {
					workflowId,
					name,
					prompt,
					triggerType: trigger,
					cronExpr: cronExpr || null
				}
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return fail(500, {
				values,
				error: `Could not start generation workflow: ${message}`
			});
		}

		redirect(303, `/w/${workflowId}?gen=pending`);
	}
};
