import { error } from '@sveltejs/kit';
import { form, getRequestEvent, query } from '$app/server';
import { requireCan } from '$lib/server/auth/permissions';
import { getDb } from '$lib/server/db';
import {
	deleteSecret as deleteSecretRow,
	isValidSecretName,
	listSecretNamesForProject,
	upsertSecret as upsertSecretRow
} from '$lib/server/db/queries/secrets';
import { getProjectForUser } from '$lib/server/db/queries/projects';
import type { ProjectRole } from '$lib/server/db/types';
import { errorMessage } from '$lib/server/util';

type Result = { ok: true; name: string } | { ok: false; error: string };

// Resolve the caller's role, 401/404ing on missing access. Used as the
// access gate for every entry in this file.
async function requireProjectRole(projectId: string): Promise<ProjectRole> {
	const event = getRequestEvent();
	if (!event.locals.user) {
		error(401, 'unauthorized');
	}
	const result = await getProjectForUser(
		getDb(event.platform!.env),
		projectId,
		event.locals.user.id
	);
	if (!result) {
		error(404, 'Project not found');
	}
	return result.role;
}

// Read-only list of secret *names* (not values) — surfaced to every project
// member so they can reference $env in workflows. Values themselves are
// write-only and are never returned by any read endpoint.
export const getSecrets = query('unchecked', async (projectId: string) => {
	await requireProjectRole(projectId);
	const event = getRequestEvent();
	return listSecretNamesForProject(getDb(event.platform!.env), projectId);
});

export const upsertSecret = form(
	'unchecked',
	async (data: { projectId: string; name: string; value: string }): Promise<Result> => {
		const event = getRequestEvent();
		const projectId = (data.projectId ?? '').trim();
		const rawName = (data.name ?? '').trim();
		const value = data.value ?? '';

		if (!projectId) {
			return { ok: false, error: 'Project ID is required.' };
		}
		if (!rawName) {
			return { ok: false, error: 'Name is required.' };
		}

		const role = await requireProjectRole(projectId);
		requireCan(role, 'secret.manage');

		const name = rawName.toUpperCase();
		if (!isValidSecretName(name)) {
			return {
				ok: false,
				error:
					'Invalid name. Use A–Z, 0–9, and underscores. Must start with a letter. Max 64 chars.'
			};
		}
		if (value === '') {
			return { ok: false, error: 'Value is required.' };
		}

		try {
			await upsertSecretRow(getDb(event.platform!.env), projectId, name, value);
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}

		void getSecrets(projectId).refresh();
		return { ok: true, name };
	}
);

export const deleteSecret = form(
	'unchecked',
	async (data: { projectId: string; name: string }): Promise<Result> => {
		const event = getRequestEvent();
		const projectId = (data.projectId ?? '').trim();
		const name = (data.name ?? '').trim();

		if (!projectId) {
			return { ok: false, error: 'Project ID is required.' };
		}
		if (!name) {
			return { ok: false, error: 'Name is required.' };
		}

		const role = await requireProjectRole(projectId);
		requireCan(role, 'secret.manage');

		try {
			await deleteSecretRow(getDb(event.platform!.env), projectId, name);
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}

		void getSecrets(projectId).refresh();
		return { ok: true, name };
	}
);
