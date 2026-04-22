import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listWorkflowsForUser } from '$lib/server/db/queries/workflows';
import { listFailedRunsForWorkflow, listRunsForWorkflow } from '$lib/server/db/queries/runs';
import { listEventsForWorkflow } from '$lib/server/db/queries/events';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const workflows = await listWorkflowsForUser(locals.user.id);

	const enriched = await Promise.all(
		workflows.map(async (w) => {
			const [failed, runs, events] = await Promise.all([
				listFailedRunsForWorkflow(w.id),
				listRunsForWorkflow(w.id),
				listEventsForWorkflow(w.id, { limit: 1000 })
			]);
			return {
				...w,
				failedRuns: failed.length,
				totalRuns: runs.length,
				totalEvents: events.length
			};
		})
	);

	return { workflows: enriched };
};
