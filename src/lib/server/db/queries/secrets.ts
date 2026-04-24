import { now } from '../index.ts';
import { fetchAll, mapRow } from '../mappers.ts';
import type { ProjectSecretMeta } from '../types.ts';

interface ProjectSecretMetaRow {
	project_id: string;
	name: string;
	created_at: number;
	updated_at: number;
}

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isValidSecretName(name: string): boolean {
	return NAME_RE.test(name);
}

export async function listSecretNamesForProject(
	db: D1Database,
	projectId: string
): Promise<ProjectSecretMeta[]> {
	return fetchAll<ProjectSecretMetaRow, ProjectSecretMeta>(
		db
			.prepare(
				`SELECT project_id, name, created_at, updated_at
				 FROM project_secrets WHERE project_id = ? ORDER BY name ASC`
			)
			.bind(projectId)
	);
}

export async function upsertSecret(
	db: D1Database,
	projectId: string,
	name: string,
	value: string
): Promise<ProjectSecretMeta> {
	if (!isValidSecretName(name)) {
		throw new Error(
			`Invalid secret name: ${name}. Use uppercase letters, digits, and underscores; must start with a letter.`
		);
	}
	const ts = now();
	await db
		.prepare(
			`INSERT INTO project_secrets (project_id, name, value, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(project_id, name) DO UPDATE
			   SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(projectId, name, value, ts, ts)
		.run();
	const row = await db
		.prepare(
			`SELECT project_id, name, created_at, updated_at
			 FROM project_secrets WHERE project_id = ? AND name = ?`
		)
		.bind(projectId, name)
		.first<ProjectSecretMetaRow>();
	if (!row) {
		throw new Error(`upsertSecret: row missing after upsert (project=${projectId}, name=${name})`);
	}
	return mapRow<ProjectSecretMeta>(row);
}

export async function deleteSecret(db: D1Database, projectId: string, name: string): Promise<void> {
	await db
		.prepare(`DELETE FROM project_secrets WHERE project_id = ? AND name = ?`)
		.bind(projectId, name)
		.run();
}
