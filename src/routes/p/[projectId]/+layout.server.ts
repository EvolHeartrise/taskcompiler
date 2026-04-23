import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getProjectForUser } from '$lib/server/db/queries/projects';
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

	const workflows = await listWorkflowsForProject(project.id);
	return {
		project: { id: project.id, name: project.name },
		workflows: workflows.map((w) => ({ id: w.id, name: w.name }))
	};
};
