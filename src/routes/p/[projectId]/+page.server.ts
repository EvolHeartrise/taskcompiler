import type { PageServerLoad } from './$types';
import { listWorkflowsForProject } from '$lib/server/db/queries/workflows';
import { listFailedRunsForWorkflow, listRunsForWorkflow } from '$lib/server/db/queries/runs';
import { listEventsForWorkflow } from '$lib/server/db/queries/events';

// Project ownership is enforced by /p/[projectId]/+layout.server.ts.
export const load: PageServerLoad = async ({ params }) => {
	const workflows = await listWorkflowsForProject(params.projectId);

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
				totalEvents: events.length,
				totalRuns: runs.length
			};
		})
	);

	return { workflows: enriched };
};
