import { error, redirect } from '@sveltejs/kit';
import { command, form, getRequestEvent, query } from '$app/server';
import { requireCan } from '$lib/server/auth/permissions';
import { getDb } from '$lib/server/db';
import {
	createProject as createProjectRow,
	deleteProject as deleteProjectRow,
	getProjectForUser,
	listProjectsForUser,
	renameProject as renameProjectRow
} from '$lib/server/db/queries/projects';
import { listWorkflowsForProject } from '$lib/server/db/queries/workflows';
import { createLogger } from '$lib/server/log';
import { EVENTS } from '$lib/server/log-events';
import { PROJECT_COOKIE } from '$lib/server/projects/cookie';
import type { ProjectRole } from '$lib/server/db/types';
import { errorMessage } from '$lib/server/util';
import { tearDownWorkflow } from '$lib/server/workflows-store';

const log = createLogger('projects');

const NAME_MAX_LEN = 60;

interface ProjectListItem {
	id: string;
	name: string;
	role: ProjectRole;
	createdAt: number;
	workflowCount: number;
}

export const getProjects = query(
	async (): Promise<{
		lastVisitedProjectId: string | null;
		projects: ProjectListItem[];
	}> => {
		const event = getRequestEvent();
		if (!event.locals.user) {
			error(401, 'unauthorized');
		}
		const db = getDb(event.platform!.env);
		const projects = await listProjectsForUser(db, event.locals.user.id);
		const counts = await Promise.all(
			projects.map(async (p) => (await listWorkflowsForProject(db, p.id)).length)
		);
		const cookieId = event.cookies.get(PROJECT_COOKIE);
		const lastVisitedId = projects.find((p) => p.id === cookieId)?.id ?? null;
		return {
			lastVisitedProjectId: lastVisitedId,
			projects: projects.map((p, i) => ({
				createdAt: p.createdAt,
				id: p.id,
				name: p.name,
				role: p.role,
				workflowCount: counts[i] ?? 0
			}))
		};
	}
);

type CreateResult = { error: string };

export const createProject = form(
	'unchecked',
	async (data: { name: string }): Promise<CreateResult | undefined> => {
		const event = getRequestEvent();
		if (!event.locals.user) {
			error(401, 'unauthorized');
		}
		const name = (data.name ?? '').trim();
		if (!name) {
			return { error: 'Name is required.' };
		}
		if (name.length > NAME_MAX_LEN) {
			return { error: `Name must be ≤ ${NAME_MAX_LEN} characters.` };
		}
		let newId: string;
		try {
			const project = await createProjectRow(getDb(event.platform!.env), {
				name,
				userId: event.locals.user.id
			});
			newId = project.id;
		} catch (err) {
			return { error: errorMessage(err) };
		}
		// The project layout writes the "last visited" cookie on entry.
		redirect(303, `/p/${newId}`);
	}
);

type RenameResult = { ok: true; id: string; name: string } | { ok: false; error: string };

export const renameProject = form(
	'unchecked',
	async (data: { projectId: string; name: string }): Promise<RenameResult> => {
		const event = getRequestEvent();
		if (!event.locals.user) {
			error(401, 'unauthorized');
		}
		const projectId = (data.projectId ?? '').trim();
		const name = (data.name ?? '').trim();
		if (!projectId || !name) {
			return { ok: false, error: 'projectId and name are required.' };
		}
		if (name.length > NAME_MAX_LEN) {
			return { ok: false, error: `Name must be ≤ ${NAME_MAX_LEN} characters.` };
		}
		const db = getDb(event.platform!.env);
		const result = await getProjectForUser(db, projectId, event.locals.user.id);
		if (!result) {
			return { ok: false, error: 'Project not found.' };
		}
		requireCan(result.role, 'project.rename');
		const updated = await renameProjectRow(db, projectId, event.locals.user.id, name);
		if (!updated) {
			return { ok: false, error: 'Project not found.' };
		}
		void getProjects().refresh();
		return { ok: true, id: updated.id, name: updated.name };
	}
);

type DeleteResult = { ok: true } | { ok: false; error: string };

export const deleteProject = command(
	'unchecked',
	async ({
		projectId,
		confirmName
	}: {
		projectId: string;
		confirmName: string;
	}): Promise<DeleteResult> => {
		const event = getRequestEvent();
		if (!event.locals.user) {
			error(401, 'unauthorized');
		}
		const env = event.platform!.env;
		const db = getDb(env);
		const access = await getProjectForUser(db, projectId, event.locals.user.id);
		if (!access) {
			return { error: 'Project not found.', ok: false };
		}
		requireCan(access.role, 'project.delete');
		const expectedName = access.project.name;
		if ((confirmName ?? '') !== expectedName) {
			return {
				error: `Type the project name exactly to confirm. Expected "${expectedName}".`,
				ok: false
			};
		}
		// Tear each workflow down individually so its WFP scripts are deleted
		// from Cloudflare and its non-cascade inner FKs (current_version_id,
		// parent_version_id, healed_from_run_id, parent_run_id,
		// triggering_run_id, new_version_id) are cleared in FK-safe order.
		// A bare `DELETE FROM projects` would otherwise fail FK enforcement.
		const workflows = await listWorkflowsForProject(db, projectId);
		try {
			for (const wf of workflows) {
				await tearDownWorkflow(env, wf.id);
			}
		} catch (err) {
			return { error: `Delete failed: ${errorMessage(err)}`, ok: false };
		}
		const deleted = await deleteProjectRow(db, projectId);
		if (!deleted) {
			return { error: 'Project not found.', ok: false };
		}
		log.info(EVENTS.PROJECT_DELETED, {
			deleted_by: event.locals.user.id,
			project_id: projectId,
			project_name: expectedName
		});
		// Drop the last-visited cookie if it pointed at the project we just
		// deleted, so the next /projects render doesn't try to highlight a
		// missing row.
		if (event.cookies.get(PROJECT_COOKIE) === projectId) {
			event.cookies.delete(PROJECT_COOKIE, { path: '/' });
		}
		void getProjects().refresh();
		return { ok: true };
	}
);
