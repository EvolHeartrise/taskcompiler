import { getDb, mapRow, now, uuid } from '../index.ts';
import type { Project } from '../types.ts';

interface ProjectRow {
	id: string;
	user_id: string;
	name: string;
	created_at: number;
	updated_at: number;
}

function rowToProject(row: ProjectRow): Project {
	return mapRow<Project>(row);
}

export interface CreateProjectInput {
	id?: string;
	userId: string;
	name: string;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
	const id = input.id ?? uuid();
	const ts = now();
	await getDb()
		.prepare(
			`INSERT INTO projects (id, user_id, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.bind(id, input.userId, input.name, ts, ts)
		.run();
	const row = await getDb()
		.prepare(`SELECT * FROM projects WHERE id = ?`)
		.bind(id)
		.first<ProjectRow>();
	if (!row) {
		throw new Error(`createProject: row missing after insert (id=${id})`);
	}
	return rowToProject(row);
}

export async function listProjectsForUser(userId: string): Promise<Project[]> {
	const res = await getDb()
		.prepare(`SELECT * FROM projects WHERE user_id = ? ORDER BY created_at ASC`)
		.bind(userId)
		.all<ProjectRow>();
	return res.results.map(rowToProject);
}

export async function getProjectForUser(id: string, userId: string): Promise<Project | null> {
	const row = await getDb()
		.prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.first<ProjectRow>();
	return row ? rowToProject(row) : null;
}

// System-level lookup. Used by ctx-rendering paths (e.g. WFP binding) where
// The workflow id is already trusted. Prefer `getProjectForUser` in UI code.
export async function getProject(id: string): Promise<Project | null> {
	const row = await getDb()
		.prepare(`SELECT * FROM projects WHERE id = ?`)
		.bind(id)
		.first<ProjectRow>();
	return row ? rowToProject(row) : null;
}

export async function renameProject(
	id: string,
	userId: string,
	name: string
): Promise<Project | null> {
	const ts = now();
	const res = await getDb()
		.prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
		.bind(name, ts, id, userId)
		.run();
	if ((res.meta?.changes ?? 0) === 0) {
		return null;
	}
	return getProjectForUser(id, userId);
}

/**
 * Ensure the user has at least one project. Returns the user's existing
 * projects, or a freshly-minted default project if they had none. Called
 * lazily from hooks.server.ts so newly-signed-up users always land on a
 * usable project without needing a separate signup hook.
 */
export async function ensureDefaultProject(userId: string): Promise<Project[]> {
	const existing = await listProjectsForUser(userId);
	if (existing.length > 0) {
		return existing;
	}
	const created = await createProject({ name: 'Default', userId });
	return [created];
}
