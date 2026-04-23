import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { ensureDefaultProject } from '$lib/server/db/queries/projects';
import { PROJECT_COOKIE } from '$lib/server/projects/cookie';

// Bare `/` has no project context. Redirect to the last-visited project
// (from the cookie) or the user's first project. ensureDefaultProject
// Guarantees at least one project exists.
export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (!locals.user) {
		error(401, 'unauthorized');
	}
	const projects = await ensureDefaultProject(locals.user.id);
	const cookieId = cookies.get(PROJECT_COOKIE);
	const target = (cookieId ? projects.find((p) => p.id === cookieId) : undefined) ?? projects[0];
	if (!target) {
		error(500, 'no project available');
	}
	redirect(303, `/p/${target.id}`);
};
