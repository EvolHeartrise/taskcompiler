import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	deleteSecret,
	isValidSecretName,
	listSecretNamesForUser,
	upsertSecret
} from '$lib/server/db/queries/secrets';
import { redeployUserCurrentVersions } from '$lib/server/workflows-store';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		error(401, 'unauthorized');
	}
	const secrets = await listSecretNamesForUser(locals.user.id);
	return { secrets };
};

export const actions: Actions = {
	delete: async ({ request, locals }) => {
		if (!locals.user) error(401, 'unauthorized');
		const userId = locals.user.id;
		const data = await request.formData();
		const name = (data.get('name') ?? '').toString().trim();
		if (!name) {
			return fail(400, { delete: { error: 'Name is required.' } });
		}
		try {
			await deleteSecret(userId, name);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return fail(500, { delete: { error: msg } });
		}

		let redeployStats: { attempted: number; ok: number; failed: number } | null = null;
		try {
			redeployStats = await redeployUserCurrentVersions(userId);
		} catch (err) {
			console.error('[secrets] redeploy on delete failed', err);
		}

		return {
			delete: {
				ok: true,
				name,
				redeploy: redeployStats
			}
		};
	},

	upsert: async ({ request, locals }) => {
		if (!locals.user) error(401, 'unauthorized');
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
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return fail(500, { upsert: { error: msg } });
		}

		let redeployStats: { attempted: number; ok: number; failed: number } | null = null;
		try {
			redeployStats = await redeployUserCurrentVersions(userId);
		} catch (err) {
			console.error('[secrets] redeploy on upsert failed', err);
		}

		return {
			upsert: {
				ok: true,
				name,
				redeploy: redeployStats
			}
		};
	}
};
