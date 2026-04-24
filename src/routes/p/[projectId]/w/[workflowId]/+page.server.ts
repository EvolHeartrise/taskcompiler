import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getWorkflowForProject } from '$lib/server/db/queries/workflows';
import { getEventSource } from '$lib/server/db/queries/event-sources';
import { getCurrentVersion, getVersion, listVersions } from '$lib/server/db/queries/versions';
import { listEventsForWorkflow } from '$lib/server/db/queries/events';
import { listFailedRunsForWorkflow, listRunsForWorkflow } from '$lib/server/db/queries/runs';
import {
	getOpenNeedsAttentionSession,
	listHealSessionsForWorkflow
} from '$lib/server/db/queries/heal-sessions';
import { highlightTs } from '$lib/server/highlight';

// Layout enforces project ownership; the workflow lookup is still scoped by
// project so /p/A/w/[id-of-B-workflow] 404s rather than leaking.
export const load: PageServerLoad = async ({ params, url }) => {
	const workflow = await getWorkflowForProject(params.workflowId, params.projectId);
	if (!workflow) {
		error(404, 'Workflow not found');
	}

	const [
		eventSource,
		currentVersion,
		versions,
		events,
		allRuns,
		failedRuns,
		heals,
		needsAttention
	] = await Promise.all([
		getEventSource(workflow.eventSourceId),
		getCurrentVersion(workflow.id),
		listVersions(workflow.id),
		listEventsForWorkflow(workflow.id, { limit: 50 }),
		listRunsForWorkflow(workflow.id),
		listFailedRunsForWorkflow(workflow.id),
		listHealSessionsForWorkflow(workflow.id),
		getOpenNeedsAttentionSession(workflow.id)
	]);
	if (!eventSource) {
		// Shouldn't happen — cascade would have wiped the workflow. Treat as 404.
		error(404, 'Event source for this workflow was deleted');
	}
	const runs = allRuns.slice(0, 50);

	const totalRuns = allRuns.length;
	const totalEvents = (await listEventsForWorkflow(workflow.id, { limit: 10_000 })).length;

	const selectedVersionId = url.searchParams.get('version');
	const selectedVersion =
		(selectedVersionId ? await getVersion(selectedVersionId) : null) ?? currentVersion;

	const selectedVersionSourceHtml = selectedVersion
		? await highlightTs(selectedVersion.sourceTs)
		: null;

	return {
		currentVersion,
		eventSource,
		events,
		failedRuns,
		heals,
		needsAttention,
		origin: url.origin,
		runs,
		selectedVersion,
		selectedVersionSourceHtml,
		stats: {
			totalEvents,
			totalFailed: failedRuns.length,
			totalHeals: heals.length,
			totalRuns
		},
		versions,
		workflow
	};
};
