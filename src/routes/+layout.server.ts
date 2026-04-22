import type { LayoutServerLoad } from './$types';
import { listWorkflowsForUser } from '$lib/server/db/queries/workflows';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		return { user: null, workflows: [] };
	}
	const workflows = await listWorkflowsForUser(locals.user.id);
	return {
		user: locals.user,
		workflows: workflows.map((w) => ({ id: w.id, name: w.name }))
	};
};
