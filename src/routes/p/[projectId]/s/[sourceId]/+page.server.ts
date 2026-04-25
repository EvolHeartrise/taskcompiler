import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireCan } from '$lib/server/auth/permissions';
import { getDb } from '$lib/server/db';
import { deleteEventSource, getEventSourceForProject } from '$lib/server/db/queries/event-sources';
import { countEventsForSource, listEventsForSource } from '$lib/server/db/queries/events';
import { getProjectForUser } from '$lib/server/db/queries/projects';
import { listWorkflowsForEventSource } from '$lib/server/db/queries/workflows';
import { listRunsForWorkflow } from '$lib/server/db/queries/runs';
import { createLogger } from '$lib/server/log';
import { EVENTS } from '$lib/server/log-events';
import { tearDownWorkflow } from '$lib/server/workflows-store';
import { errorMessage } from '$lib/server/util';

const log = createLogger('source-delete');

// Layout enforces project ownership; the event-source lookup is still scoped
// by project so /p/A/s/[id-of-B-source] 404s rather than leaking.
export const load: PageServerLoad = async ({ params, url, platform }) => {
	const db = getDb(platform!.env);
	const source = await getEventSourceForProject(db, params.sourceId, params.projectId);
	if (!source) {
		error(404, 'Event source not found');
	}

	const [recentEvents, totalEvents, workflows] = await Promise.all([
		listEventsForSource(db, source.id, { limit: 50 }),
		countEventsForSource(db, source.id),
		listWorkflowsForEventSource(db, source.id)
	]);

	const enrichedWorkflows = await Promise.all(
		workflows.map(async (w) => {
			const runs = await listRunsForWorkflow(db, w.id);
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
	delete: async ({ locals, params, request, platform }) => {
		const env = platform!.env;
		const db = getDb(env);
		if (!locals.user) {
			error(401, 'unauthorized');
		}
		const projectResult = await getProjectForUser(db, params.projectId, locals.user.id);
		if (!projectResult) {
			error(404, 'Project not found');
		}
		requireCan(projectResult.role, 'eventSource.manage');
		const source = await getEventSourceForProject(db, params.sourceId, params.projectId);
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
			const workflows = await listWorkflowsForEventSource(db, source.id);
			for (const w of workflows) {
				try {
					await tearDownWorkflow(env, w.id);
				} catch (err) {
					log.error(EVENTS.TEARDOWN_WFP_DELETE_FAILED, {
						error: errorMessage(err),
						workflow_id: w.id,
						source: 'source-delete'
					});
				}
			}
			await deleteEventSource(db, source.id);
		} catch (err) {
			return fail(500, { delete: { error: `Delete failed: ${errorMessage(err)}` } });
		}
		redirect(303, `/p/${params.projectId}`);
	}
};
