import type { PageServerLoad } from './$types';
import { listWorkflows } from '$lib/server/db/queries/workflows';
import { listFailedRunsForWorkflow, listRunsForWorkflow } from '$lib/server/db/queries/runs';
import { listEventsForWorkflow } from '$lib/server/db/queries/events';

export const load: PageServerLoad = async () => {
	const workflows = listWorkflows();

	const enriched = workflows.map((w) => {
		const failed = listFailedRunsForWorkflow(w.id).length;
		const runs = listRunsForWorkflow(w.id).length;
		const events = listEventsForWorkflow(w.id, { limit: 1000 }).length;
		return {
			...w,
			failedRuns: failed,
			totalRuns: runs,
			totalEvents: events
		};
	});

	return { workflows: enriched };
};
