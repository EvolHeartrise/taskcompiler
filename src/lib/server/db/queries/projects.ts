import { now, uuid } from '../index.ts';
import { fetchOne, mapRow } from '../mappers.ts';
import type { Project, ProjectRole } from '../types.ts';

interface ProjectRow {
	id: string;
	user_id: string;
	name: string;
	created_at: number;
	updated_at: number;
}

interface ProjectWithRoleRow extends ProjectRow {
	role: ProjectRole;
}

export interface ProjectWithRole {
	project: Project;
	role: ProjectRole;
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

// Returns each project the user is a member of plus their role on it. Role
// is folded in here (vs. a per-project lookup) because callers like the
// `/projects` page need it to gate UI affordances per row.
export async function listProjectsForUser(
	db: D1Database,
	userId: string
): Promise<(Project & { role: ProjectRole })[]> {
	const res = await db
		.prepare(
			`SELECT p.*, m.role AS role FROM projects p
			 JOIN project_members m ON m.project_id = p.id
			 WHERE m.user_id = ?
			 ORDER BY p.created_at ASC`
		)
		.bind(userId)
		.all<ProjectWithRoleRow>();
	return res.results.map((row) => {
		const project = mapRow<Project>(row, ['role']);
		return { ...project, role: row.role };
	});
}

// Returns the project and the caller's role on it, or null if the caller is
// not a member. Role is needed for permission gating at every project-scoped
// entry point — see `src/lib/server/auth/permissions.ts`.
export async function getProjectForUser(
	db: D1Database,
	id: string,
	userId: string
): Promise<ProjectWithRole | null> {
	const row = await db
		.prepare(
			`SELECT p.*, m.role AS role FROM projects p
			 JOIN project_members m ON m.project_id = p.id
			 WHERE p.id = ? AND m.user_id = ?`
		)
		.bind(id, userId)
		.first<ProjectWithRoleRow>();
	if (!row) {
		return null;
	}
	const project = mapRow<Project>(row, ['role']);
	return { project, role: row.role };
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
	// member of the project can rename it. The route handler should
	// additionally enforce role-based permission via `requireCan` before
	// calling this — the SQL guard is belt-and-braces.
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
	const result = await getProjectForUser(db, id, userId);
	return result?.project ?? null;
}

// Drops the project row. FK cascades remove event_sources, workflows,
// project_members, project_invites, project_secrets — and the workflow
// children that have clean cascades (events via event_sources, runs via
// workflows, workflow_versions/workflow_state via workflows). Workflow-
// internal non-cascade FKs (current_version_id, parent_version_id,
// healed_from_run_id, parent_run_id, triggering_run_id, new_version_id)
// must be cleared first by calling `tearDownWorkflow` per-workflow before
// invoking this — see the project-delete remote command for the wrapper.
export async function deleteProject(db: D1Database, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM projects WHERE id = ?`).bind(id).run();
	return (res.meta?.changes ?? 0) > 0;
}

export async function ensureDefaultProject(db: D1Database, userId: string): Promise<Project[]> {
	const existing = await listProjectsForUser(db, userId);
	if (existing.length > 0) {
		return existing;
	}
	const created = await createProject(db, { name: 'Default', userId });
	return [created];
}
