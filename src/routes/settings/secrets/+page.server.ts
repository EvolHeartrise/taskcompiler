import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	deleteSecret,
	isValidSecretName,
	listSecretNamesForUser,
	upsertSecret
} from '$lib/server/db/queries/secrets';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		error(401, 'unauthorized');
	}
	const secrets = await listSecretNamesForUser(locals.user.id);
	return { secrets };
};

export const actions: Actions = {
	delete: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'unauthorized');
		}
		const userId = locals.user.id;
		const data = await request.formData();
		const name = (data.get('name') ?? '').toString().trim();
		if (!name) {
			return fail(400, { delete: { error: 'Name is required.' } });
		}
		try {
			await deleteSecret(userId, name);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return fail(500, { delete: { error: msg } });
		}
		return { delete: { name, ok: true } };
	},

	upsert: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'unauthorized');
		}
		const userId = locals.user.id;
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
			await upsertSecret(userId, name, value);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return fail(500, { upsert: { error: msg } });
		}
		return { upsert: { name, ok: true } };
	}
};
