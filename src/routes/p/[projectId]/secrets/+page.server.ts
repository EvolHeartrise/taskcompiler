import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	deleteSecret,
	isValidSecretName,
	listSecretNamesForProject,
	upsertSecret
} from '$lib/server/db/queries/secrets';
import { errorMessage } from '$lib/server/util';

// Project ownership is enforced by /p/[projectId]/+layout.server.ts.
export const load: PageServerLoad = async ({ params }) => {
	const secrets = await listSecretNamesForProject(params.projectId);
	return { secrets };
};

export const actions: Actions = {
	delete: async ({ request, params }) => {
		const data = await request.formData();
		const name = (data.get('name') ?? '').toString().trim();
		if (!name) {
			return fail(400, { delete: { error: 'Name is required.' } });
		}
		try {
			await deleteSecret(params.projectId, name);
		} catch (error) {
			return fail(500, { delete: { error: errorMessage(error) } });
		}
		return { delete: { name, ok: true } };
	},

	upsert: async ({ request, params }) => {
		const data = await request.formData();
		const rawName = (data.get('name') ?? '').toString().trim();
		const value = (data.get('value') ?? '').toString();

		if (!rawName) {
			return fail(400, { upsert: { error: 'Name is required.' } });
		}
		const name = rawName.toUpperCase();
		if (!isValidSecretName(name)) {
			return fail(400, {
				upsert: {
					error:
						'Invalid name. Use A–Z, 0–9, and underscores. Must start with a letter. Max 64 chars.'
				}
			});
		}
		if (value === '') {
			return fail(400, { upsert: { error: 'Value is required.' } });
		}

		try {
			await upsertSecret(params.projectId, name, value);
		} catch (error) {
			return fail(500, { upsert: { error: errorMessage(error) } });
		}
		return { upsert: { name, ok: true } };
	}
};
