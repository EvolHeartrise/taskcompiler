import type { LayoutServerLoad } from './$types';
import { listProjectsForUser } from '$lib/server/db/queries/projects';

export const load: LayoutServerLoad = async ({ locals, platform }) => {
	if (!locals.user) {
		return { projects: [], user: null };
	}
	const projects = await listProjectsForUser(platform!.env.DB, locals.user.id);
	return {
		projects: projects.map((p) => ({ id: p.id, name: p.name })),
		user: locals.user
	};
};
