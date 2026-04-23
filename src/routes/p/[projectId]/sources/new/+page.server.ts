import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { createEventSource } from '$lib/server/db/queries/event-sources';
import type { TriggerType } from '$lib/server/db/types';

export const actions: Actions = {
	default: async (event) => {
		const data = await event.request.formData();
		const name = (data.get('name') ?? '').toString().trim();
		const triggerRaw = (data.get('trigger') ?? '').toString().trim();
		const cronExpr = (data.get('cronExpr') ?? '').toString().trim();

		const values = { cronExpr, name, trigger: triggerRaw };

		if (!name) {
			return fail(400, { error: 'Name is required.', values });
		}
		if (triggerRaw !== 'webhook' && triggerRaw !== 'cron') {
			return fail(400, { error: 'Trigger must be webhook or cron.', values });
		}
		const trigger = triggerRaw as TriggerType;
		if (trigger === 'cron' && !cronExpr) {
			return fail(400, { error: 'Cron expression is required for cron triggers.', values });
		}

		// Project ownership is enforced by /p/[projectId]/+layout.server.ts.
		const { projectId } = event.params;
		const id = crypto.randomUUID();

		try {
			await createEventSource({
				cronExpr: cronExpr || null,
				id,
				name,
				projectId,
				triggerType: trigger
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(500, { error: `Could not create event: ${message}`, values });
		}

		redirect(303, `/p/${projectId}/s/${id}`);
	}
};
