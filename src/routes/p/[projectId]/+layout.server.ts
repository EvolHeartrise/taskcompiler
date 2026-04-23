import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getProjectForUser } from '$lib/server/db/queries/projects';
import { listEventSourcesForProject } from '$lib/server/db/queries/event-sources';
import { listWorkflowsForProject } from '$lib/server/db/queries/workflows';
import { setProjectCookie } from '$lib/server/projects/cookie';

// Single point of project-ownership enforcement for everything under
// /p/[projectId]/. Children can trust that `params.projectId` belongs to the
// Signed-in user. Also refreshes the "last visited" cookie so `/` knows
// Where to redirect on the next bare visit.
export const load: LayoutServerLoad = async ({ locals, params, cookies, url }) => {
	if (!locals.user) {
		error(401, 'unauthorized');
	}
	const project = await getProjectForUser(params.projectId, locals.user.id);
	if (!project) {
		error(404, 'Project not found');
	}

	setProjectCookie(cookies, project.id, url.protocol === 'https:');

	const [sources, workflows] = await Promise.all([
		listEventSourcesForProject(project.id),
		listWorkflowsForProject(project.id)
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
