import type { PageServerLoad } from './$types';
import { listEventSourcesForProject } from '$lib/server/db/queries/event-sources';
import { countEventsForSource } from '$lib/server/db/queries/events';
import {
	listWorkflowsForEventSource,
	listWorkflowsForProject
} from '$lib/server/db/queries/workflows';
import { listFailedRunsForWorkflow, listRunsForWorkflow } from '$lib/server/db/queries/runs';

// Project ownership is enforced by /p/[projectId]/+layout.server.ts.
export const load: PageServerLoad = async ({ params }) => {
	const [sources, workflows] = await Promise.all([
		listEventSourcesForProject(params.projectId),
		listWorkflowsForProject(params.projectId)
	]);

	const enrichedSources = await Promise.all(
		sources.map(async (s) => {
			const [events, attached] = await Promise.all([
				countEventsForSource(s.id),
				listWorkflowsForEventSource(s.id)
			]);
			return {
				...s,
				totalEvents: events,
				workflowCount: attached.length
			};
		})
	);

	const enrichedWorkflows = await Promise.all(
		workflows.map(async (w) => {
			const [failed, runs] = await Promise.all([
				listFailedRunsForWorkflow(w.id),
				listRunsForWorkflow(w.id)
			]);
			return {
				...w,
				failedRuns: failed.length,
				totalRuns: runs.length
			};
		})
	);

	return {
		eventSources: enrichedSources,
		workflows: enrichedWorkflows
	};
};
