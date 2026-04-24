import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getProjectForUser } from '$lib/server/db/queries/projects';
import { listEventSourcesForProject } from '$lib/server/db/queries/event-sources';
import { listWorkflowsForProject } from '$lib/server/db/queries/workflows';
import { setProjectCookie } from '$lib/server/projects/cookie';

// Single point of project-ownership enforcement for everything under
// /p/[projectId]/. Children can trust `params.projectId` belongs to the
// signed-in user. Also refreshes the "last visited" cookie so `/` knows
// where to redirect on the next bare visit.
export const load: LayoutServerLoad = async ({ locals, params, cookies, url, platform }) => {
	if (!locals.user) {
		error(401, 'unauthorized');
	}
	const db = getDb(platform!.env);
	const project = await getProjectForUser(db, params.projectId, locals.user.id);
	if (!project) {
		error(404, 'Project not found');
	}

	setProjectCookie(cookies, project.id, url.protocol === 'https:');

	const [sources, workflows] = await Promise.all([
		listEventSourcesForProject(db, project.id),
		listWorkflowsForProject(db, project.id)
	]);
	return {
		eventSources: sources.map((s) => ({
			cronExpr: s.cronExpr,
			id: s.id,
			name: s.name,
			triggerType: s.triggerType
		})),
		project: { id: project.id, name: project.name },
		workflows: workflows.map((w) => ({
			eventSourceId: w.eventSourceId,
			id: w.id,
			name: w.name
		}))
	};
};
