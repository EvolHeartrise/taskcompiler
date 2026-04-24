import { error, redirect } from '@sveltejs/kit';
import { form, getRequestEvent, query } from '$app/server';
import { getDb } from '$lib/server/db';
import {
	createProject as createProjectRow,
	getProjectForUser,
	listProjectsForUser,
	renameProject as renameProjectRow
} from '$lib/server/db/queries/projects';
import { listWorkflowsForProject } from '$lib/server/db/queries/workflows';
import { PROJECT_COOKIE } from '$lib/server/projects/cookie';
import { errorMessage } from '$lib/server/util';

const NAME_MAX_LEN = 60;

interface ProjectListItem {
	id: string;
	name: string;
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
		const project = await getProjectForUser(db, projectId, event.locals.user.id);
		if (!project) {
			return { ok: false, error: 'Project not found.' };
		}
		const updated = await renameProjectRow(db, projectId, event.locals.user.id, name);
		if (!updated) {
			return { ok: false, error: 'Project not found.' };
		}
		void getProjects().refresh();
		return { ok: true, id: updated.id, name: updated.name };
	}
);
