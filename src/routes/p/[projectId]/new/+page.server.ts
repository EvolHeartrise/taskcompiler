import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	getEventSourceForProject,
	listEventSourcesForProject
} from '$lib/server/db/queries/event-sources';
import { countEventsForSource } from '$lib/server/db/queries/events';
import { createWorkflow } from '$lib/server/db/queries/workflows';
import { env } from 'cloudflare:workers';
import { errorMessage } from '$lib/server/util';

export const load: PageServerLoad = async ({ params, url }) => {
	const sources = await listEventSourcesForProject(params.projectId);

	const preselectedId = url.searchParams.get('source');
	let preselected = null;
	if (preselectedId) {
		preselected = await getEventSourceForProject(preselectedId, params.projectId);
		if (!preselected) {
			error(404, 'Event source not found');
		}
	}

	// Event counts feed the "backfill" checkbox UI — no events means there's
	// nothing to backfill against.
	const sourcesWithCount = await Promise.all(
		sources.map(async (s) => ({
			cronExpr: s.cronExpr,
			eventCount: await countEventsForSource(s.id),
			id: s.id,
			name: s.name,
			triggerType: s.triggerType
		}))
	);

	return {
		eventSources: sourcesWithCount,
		preselectedSourceId: preselected?.id ?? null
	};
};

export const actions: Actions = {
	default: async (event) => {
		const data = await event.request.formData();
		const name = (data.get('name') ?? '').toString().trim();
		const prompt = (data.get('prompt') ?? '').toString().trim();
		const sourceId = (data.get('sourceId') ?? '').toString().trim();
		const backfill = data.get('backfill') === 'on';

		const values = { backfill, name, prompt, sourceId };

		if (!name) {
			return fail(400, { error: 'Name is required.', values });
		}
		if (!prompt) {
			return fail(400, { error: 'Prompt is required.', values });
		}
		if (!sourceId) {
			return fail(400, { error: 'Event source is required.', values });
		}

		const { projectId } = event.params;
		const source = await getEventSourceForProject(sourceId, projectId);
		if (!source) {
			return fail(400, { error: 'Event source not found in this project.', values });
		}

		const workflowId = crypto.randomUUID();

		try {
			await createWorkflow({
				eventSourceId: source.id,
				id: workflowId,
				name,
				projectId,
				prompt
			});
		} catch (err) {
			return fail(500, {
				error: `Could not create workflow: ${errorMessage(err)}`,
				values
			});
		}

		try {
			await env.GEN_WORKFLOW.create({
				id: `gen-${workflowId}`,
				params: {
					backfill,
					name,
					prompt,
					workflowId
				}
			});
		} catch (err) {
			return fail(500, {
				error: `Could not start generation workflow: ${errorMessage(err)}`,
				values
			});
		}

		redirect(303, `/p/${projectId}/w/${workflowId}?gen=pending`);
	}
};
