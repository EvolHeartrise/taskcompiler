import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	getEventSourceForProject,
	listEventSourcesForProject
} from '$lib/server/db/queries/event-sources';
import { countEventsForSource } from '$lib/server/db/queries/events';
import { createWorkflow } from '$lib/server/db/queries/workflows';

// Workflow creation form. Requires an event source — either picked via
// `?source=<id>` (from the source detail page / project home) or selected
// From the list below.
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

	// Show event counts so the "backfill" checkbox makes sense — no events =
	// Nothing to backfill against.
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

		if (!event.platform) {
			return fail(500, { error: 'Platform bindings unavailable.', values });
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
			const message = err instanceof Error ? err.message : String(err);
			return fail(500, { error: `Could not create workflow: ${message}`, values });
		}

		try {
			await event.platform.env.GEN_WORKFLOW.create({
				id: `gen-${workflowId}`,
				params: {
					backfill,
					name,
					prompt,
					workflowId
				}
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return fail(500, {
				error: `Could not start generation workflow: ${message}`,
				values
			});
		}

		redirect(303, `/p/${projectId}/w/${workflowId}?gen=pending`);
	}
};
