import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
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
export const load: PageServerLoad = async ({ params, url, platform }) => {
	const db = getDb(platform!.env);
	const workflow = await getWorkflowForProject(db, params.workflowId, params.projectId);
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
		getEventSource(db, workflow.eventSourceId),
		getCurrentVersion(db, workflow.id),
		listVersions(db, workflow.id),
		listEventsForWorkflow(db, workflow.id, { limit: 50 }),
		listRunsForWorkflow(db, workflow.id),
		listFailedRunsForWorkflow(db, workflow.id),
		listHealSessionsForWorkflow(db, workflow.id),
		getOpenNeedsAttentionSession(db, workflow.id)
	]);
	if (!eventSource) {
		// Shouldn't happen — cascade would have wiped the workflow. Treat as 404.
		error(404, 'Event source for this workflow was deleted');
	}
	const runs = allRuns.slice(0, 50);

	const totalRuns = allRuns.length;
	const totalEvents = (await listEventsForWorkflow(db, workflow.id, { limit: 10_000 })).length;

	const selectedVersionId = url.searchParams.get('version');
	const selectedVersion =
		(selectedVersionId ? await getVersion(db, selectedVersionId) : null) ?? currentVersion;

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
