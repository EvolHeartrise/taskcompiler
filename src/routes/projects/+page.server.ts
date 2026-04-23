import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { PROJECT_COOKIE } from '$lib/server/projects/cookie';
import {
	createProject,
	getProjectForUser,
	listProjectsForUser,
	renameProject
} from '$lib/server/db/queries/projects';
import { listWorkflowsForProject } from '$lib/server/db/queries/workflows';

const NAME_MAX_LEN = 60;

export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (!locals.user) {
		error(401, 'unauthorized');
	}
	const projects = await listProjectsForUser(locals.user.id);
	const counts = await Promise.all(
		projects.map(async (p) => (await listWorkflowsForProject(p.id)).length)
	);
	const cookieId = cookies.get(PROJECT_COOKIE);
	const lastVisitedId = projects.find((p) => p.id === cookieId)?.id ?? null;
	return {
		lastVisitedProjectId: lastVisitedId,
		projects: projects.map((p, i) => ({
			createdAt: p.createdAt,
			id: p.id,
			name: p.name,
			workflowCount: counts[i]
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'unauthorized');
		}
		const data = await request.formData();
		const name = (data.get('name') ?? '').toString().trim();
		if (!name) {
			return fail(400, { create: { error: 'Name is required.' } });
		}
		if (name.length > NAME_MAX_LEN) {
			return fail(400, { create: { error: `Name must be ≤ ${NAME_MAX_LEN} characters.` } });
		}
		let newId: string;
		try {
			const project = await createProject({ name, userId: locals.user.id });
			newId = project.id;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return fail(500, { create: { error: msg } });
		}
		// The project layout writes the "last visited" cookie on entry, so we
		// Just navigate.
		redirect(303, `/p/${newId}`);
	},

	rename: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'unauthorized');
		}
		const data = await request.formData();
		const projectId = (data.get('projectId') ?? '').toString().trim();
		const name = (data.get('name') ?? '').toString().trim();
		if (!projectId || !name) {
			return fail(400, { rename: { error: 'projectId and name are required.' } });
		}
		if (name.length > NAME_MAX_LEN) {
			return fail(400, { rename: { error: `Name must be ≤ ${NAME_MAX_LEN} characters.` } });
		}
		const project = await getProjectForUser(projectId, locals.user.id);
		if (!project) {
			return fail(404, { rename: { error: 'Project not found.' } });
		}
		const updated = await renameProject(projectId, locals.user.id, name);
		if (!updated) {
			return fail(404, { rename: { error: 'Project not found.' } });
		}
		return { rename: { id: updated.id, name: updated.name, ok: true } };
	}
};
