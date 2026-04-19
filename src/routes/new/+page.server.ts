import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { generateWorkflow } from '$lib/server/agent/roles';
import type { TriggerType } from '$lib/server/db/types';

export const actions: Actions = {
	default: async ({ request }) => {
		const data = await request.formData();
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

		let workflowId: string;
		try {
			const result = await generateWorkflow({
				name,
				prompt,
				triggerType: trigger,
				cronExpr: cronExpr || null
			});
			workflowId = result.workflowId;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return fail(500, { values, error: `Generation failed: ${message}` });
		}

		redirect(303, `/w/${workflowId}`);
	}
};
