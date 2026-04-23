import { getDb, mapRow, now } from '../index.ts';
import type { ProjectSecret, ProjectSecretMeta } from '../types.ts';

interface ProjectSecretMetaRow {
	project_id: string;
	name: string;
	created_at: number;
	updated_at: number;
}

interface ProjectSecretRow extends ProjectSecretMetaRow {
	value: string;
}

function rowToMeta(row: ProjectSecretMetaRow): ProjectSecretMeta {
	return mapRow<ProjectSecretMeta>(row);
}

function rowToSecret(row: ProjectSecretRow): ProjectSecret {
	return mapRow<ProjectSecret>(row);
}

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isValidSecretName(name: string): boolean {
	return NAME_RE.test(name);
}

export async function listSecretNamesForProject(projectId: string): Promise<ProjectSecretMeta[]> {
	const res = await getDb()
		.prepare(
			`SELECT project_id, name, created_at, updated_at
			 FROM project_secrets WHERE project_id = ? ORDER BY name ASC`
		)
		.bind(projectId)
		.all<ProjectSecretMetaRow>();
	return res.results.map(rowToMeta);
}

export async function getSecretsForProject(projectId: string): Promise<ProjectSecret[]> {
	const res = await getDb()
		.prepare(
			`SELECT project_id, name, value, created_at, updated_at
			 FROM project_secrets WHERE project_id = ? ORDER BY name ASC`
		)
		.bind(projectId)
		.all<ProjectSecretRow>();
	return res.results.map(rowToSecret);
}

export async function upsertSecret(
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
	await getDb()
		.prepare(
			`INSERT INTO project_secrets (project_id, name, value, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(project_id, name) DO UPDATE
			   SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(projectId, name, value, ts, ts)
		.run();
	const row = await getDb()
		.prepare(
			`SELECT project_id, name, created_at, updated_at
			 FROM project_secrets WHERE project_id = ? AND name = ?`
		)
		.bind(projectId, name)
		.first<ProjectSecretMetaRow>();
	if (!row) {
		throw new Error(`upsertSecret: row missing after upsert (project=${projectId}, name=${name})`);
	}
	return rowToMeta(row);
}

export async function deleteSecret(projectId: string, name: string): Promise<void> {
	await getDb()
		.prepare(`DELETE FROM project_secrets WHERE project_id = ? AND name = ?`)
		.bind(projectId, name)
		.run();
}
