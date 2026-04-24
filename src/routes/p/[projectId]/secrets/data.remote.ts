import { form, getRequestEvent, query } from '$app/server';
import { getDb } from '$lib/server/db';
import {
	deleteSecret as deleteSecretRow,
	isValidSecretName,
	listSecretNamesForProject,
	upsertSecret as upsertSecretRow
} from '$lib/server/db/queries/secrets';
import { errorMessage } from '$lib/server/util';

type Result = { ok: true; name: string } | { ok: false; error: string };

export const getSecrets = query('unchecked', async (projectId: string) => {
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

		try {
			await deleteSecretRow(getDb(event.platform!.env), projectId, name);
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}

		void getSecrets(projectId).refresh();
		return { ok: true, name };
	}
);
