import { redirect } from '@sveltejs/kit';
import { form, getRequestEvent } from '$app/server';
import { getDb } from '$lib/server/db';
import { createEventSource } from '$lib/server/db/queries/event-sources';
import type { TriggerType } from '$lib/server/db/types';
import { errorMessage } from '$lib/server/util';

type Result = {
	error: string;
	values: { name: string; trigger: string; cronExpr: string };
};

export const createEventSourceForProject = form(
	'unchecked',
	async (data: {
		projectId: string;
		name: string;
		trigger: string;
		cronExpr: string;
	}): Promise<Result | undefined> => {
		const event = getRequestEvent();
		const projectId = (data.projectId ?? '').trim();
		const name = (data.name ?? '').trim();
		const triggerRaw = (data.trigger ?? '').trim();
		const cronExpr = (data.cronExpr ?? '').trim();

		const values = { cronExpr, name, trigger: triggerRaw };

		if (!projectId) {
			return { error: 'Project ID is required.', values };
		}
		if (!name) {
			return { error: 'Name is required.', values };
		}
		if (triggerRaw !== 'webhook' && triggerRaw !== 'cron') {
			return { error: 'Trigger must be webhook or cron.', values };
		}
		const trigger = triggerRaw as TriggerType;
		if (trigger === 'cron' && !cronExpr) {
			return { error: 'Cron expression is required for cron triggers.', values };
		}

		const id = crypto.randomUUID();

		try {
			await createEventSource(getDb(event.platform!.env), {
				cronExpr: cronExpr || null,
				id,
				name,
				projectId,
				triggerType: trigger
			});
		} catch (err) {
			return { error: `Could not create event: ${errorMessage(err)}`, values };
		}

		redirect(303, `/p/${projectId}/s/${id}`);
	}
);
