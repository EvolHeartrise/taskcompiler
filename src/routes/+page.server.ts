import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { ensureDefaultProject } from '$lib/server/db/queries/projects';
import { PROJECT_COOKIE } from '$lib/server/projects/cookie';

// ensureDefaultProject guarantees at least one project exists, so the
// `!target` branch below only trips if the cookie is stale and the list
// is somehow empty.
export const load: PageServerLoad = async ({ locals, cookies, platform }) => {
	if (!locals.user) {
		error(401, 'unauthorized');
	}
	const projects = await ensureDefaultProject(platform!.env.DB, locals.user.id);
	const cookieId = cookies.get(PROJECT_COOKIE);
	const target = (cookieId ? projects.find((p) => p.id === cookieId) : undefined) ?? projects[0];
	if (!target) {
		error(500, 'no project available');
	}
	redirect(303, `/p/${target.id}`);
};
