import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { deleteEventSource, getEventSourceForProject } from '$lib/server/db/queries/event-sources';
import { countEventsForSource, listEventsForSource } from '$lib/server/db/queries/events';
import { listWorkflowsForEventSource } from '$lib/server/db/queries/workflows';
import { listRunsForWorkflow } from '$lib/server/db/queries/runs';
import { tearDownWorkflow } from '$lib/server/workflows-store';
import { errorMessage } from '$lib/server/util';

// Layout enforces project ownership; the event-source lookup is still scoped
// by project so /p/A/s/[id-of-B-source] 404s rather than leaking.
export const load: PageServerLoad = async ({ params, url }) => {
	const source = await getEventSourceForProject(params.sourceId, params.projectId);
	if (!source) {
		error(404, 'Event source not found');
	}

	const [recentEvents, totalEvents, workflows] = await Promise.all([
		listEventsForSource(source.id, { limit: 50 }),
		countEventsForSource(source.id),
		listWorkflowsForEventSource(source.id)
	]);

	const enrichedWorkflows = await Promise.all(
		workflows.map(async (w) => {
			const runs = await listRunsForWorkflow(w.id);
			const okRuns = runs.filter((r) => r.status === 'ok').length;
			const failedRuns = runs.filter((r) => r.status === 'failed').length;
			return {
				currentVersionId: w.currentVersionId,
				failedRuns,
				id: w.id,
				name: w.name,
				okRuns,
				totalRuns: runs.length
			};
		})
	);

	return {
		eventSource: source,
		events: recentEvents,
		origin: url.origin,
		stats: {
			totalEvents
		},
		workflows: enrichedWorkflows
	};
};

export const actions: Actions = {
	delete: async ({ params, request }) => {
		const source = await getEventSourceForProject(params.sourceId, params.projectId);
		if (!source) {
			error(404, 'Event source not found');
		}

		const data = await request.formData();
		const confirmName = (data.get('confirm_name') ?? '').toString();
		if (confirmName !== source.name) {
			return fail(400, {
				delete: {
					error: `Type the event name exactly to confirm. Expected "${source.name}".`
				}
			});
		}

		try {
			const workflows = await listWorkflowsForEventSource(source.id);
			for (const w of workflows) {
				try {
					await tearDownWorkflow(w.id);
				} catch (err) {
					console.error('[source-delete] tearDownWorkflow failed', {
						error: errorMessage(err),
						workflowId: w.id
					});
				}
			}
			await deleteEventSource(source.id);
		} catch (err) {
			return fail(500, { delete: { error: `Delete failed: ${errorMessage(err)}` } });
		}
		redirect(303, `/p/${params.projectId}`);
	}
};
