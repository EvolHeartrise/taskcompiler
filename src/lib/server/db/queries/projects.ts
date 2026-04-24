import { now, uuid } from '../index.ts';
import { fetchAll, fetchOne } from '../mappers.ts';
import type { Project } from '../types.ts';

interface ProjectRow {
	id: string;
	user_id: string;
	name: string;
	created_at: number;
	updated_at: number;
}

export interface CreateProjectInput {
	id?: string;
	userId: string;
	name: string;
}

export async function createProject(db: D1Database, input: CreateProjectInput): Promise<Project> {
	const id = input.id ?? uuid();
	const ts = now();
	// Creator is recorded both on `projects.user_id` (attribution) and as an
	// owner-role row in `project_members` (the access-check edge). Wrap both
	// in a D1 batch so a partial insert can never strand a project without a
	// membership row — that would lock the creator out of their own project.
	await db.batch([
		db
			.prepare(
				`INSERT INTO projects (id, user_id, name, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`
			)
			.bind(id, input.userId, input.name, ts, ts),
		db
			.prepare(
				`INSERT INTO project_members (project_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`
			)
			.bind(id, input.userId, ts)
	]);
	return {
		createdAt: ts,
		id,
		name: input.name,
		updatedAt: ts,
		userId: input.userId
	};
}

export async function listProjectsForUser(db: D1Database, userId: string): Promise<Project[]> {
	return fetchAll<ProjectRow, Project>(
		db
			.prepare(
				`SELECT p.* FROM projects p
				 JOIN project_members m ON m.project_id = p.id
				 WHERE m.user_id = ?
				 ORDER BY p.created_at ASC`
			)
			.bind(userId)
	);
}

export async function getProjectForUser(
	db: D1Database,
	id: string,
	userId: string
): Promise<Project | null> {
	return fetchOne<ProjectRow, Project>(
		db
			.prepare(
				`SELECT p.* FROM projects p
				 JOIN project_members m ON m.project_id = p.id
				 WHERE p.id = ? AND m.user_id = ?`
			)
			.bind(id, userId)
	);
}

// System-level lookup — does not enforce membership. Prefer
// `getProjectForUser` in UI code.
export async function getProject(db: D1Database, id: string): Promise<Project | null> {
	return fetchOne<ProjectRow, Project>(db.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id));
}

export async function renameProject(
	db: D1Database,
	id: string,
	userId: string,
	name: string
): Promise<Project | null> {
	const ts = now();
	// Gate the UPDATE on membership instead of `projects.user_id` so any
	// member of the project can rename it.
	const res = await db
		.prepare(
			`UPDATE projects SET name = ?, updated_at = ?
			 WHERE id = ?
			 AND EXISTS (
			   SELECT 1 FROM project_members
			   WHERE project_id = projects.id AND user_id = ?
			 )`
		)
		.bind(name, ts, id, userId)
		.run();
	if ((res.meta?.changes ?? 0) === 0) {
		return null;
	}
	return getProjectForUser(db, id, userId);
}

export async function ensureDefaultProject(db: D1Database, userId: string): Promise<Project[]> {
	const existing = await listProjectsForUser(db, userId);
	if (existing.length > 0) {
		return existing;
	}
	const created = await createProject(db, { name: 'Default', userId });
	return [created];
}
