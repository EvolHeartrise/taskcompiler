import type { PageServerLoad } from './$types';
import { listEventSourcesForProject } from '$lib/server/db/queries/event-sources';
import { countEventsBySourceForProject } from '$lib/server/db/queries/events';
import {
	countWorkflowsBySourceForProject,
	listWorkflowsForProject
} from '$lib/server/db/queries/workflows';
import { getRunStatsForProject } from '$lib/server/db/queries/runs';

// Project ownership is enforced by /p/[projectId]/+layout.server.ts.
export const load: PageServerLoad = async ({ params }) => {
	const [sources, workflows, eventsBySource, workflowsBySource, runStats] = await Promise.all([
		listEventSourcesForProject(params.projectId),
		listWorkflowsForProject(params.projectId),
		countEventsBySourceForProject(params.projectId),
		countWorkflowsBySourceForProject(params.projectId),
		getRunStatsForProject(params.projectId)
	]);

	return {
		eventSources: sources.map((s) => ({
			...s,
			totalEvents: eventsBySource.get(s.id) ?? 0,
			workflowCount: workflowsBySource.get(s.id) ?? 0
		})),
		workflows: workflows.map((w) => {
			const stats = runStats.get(w.id);
			return {
				...w,
				failedRuns: stats?.failed ?? 0,
				totalRuns: stats?.total ?? 0
			};
		})
	};
};
