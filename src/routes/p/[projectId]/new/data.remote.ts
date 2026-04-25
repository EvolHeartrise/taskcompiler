import { error, redirect } from '@sveltejs/kit';
import { form, getRequestEvent, query } from '$app/server';
import { requireCan } from '$lib/server/auth/permissions';
import { getDb } from '$lib/server/db';
import {
	getEventSourceForProject,
	listEventSourcesForProject
} from '$lib/server/db/queries/event-sources';
import { countEventsForSource } from '$lib/server/db/queries/events';
import { getProjectForUser } from '$lib/server/db/queries/projects';
import { createWorkflow } from '$lib/server/db/queries/workflows';
import type { ProjectRole } from '$lib/server/db/types';
import { errorMessage } from '$lib/server/util';

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

interface EventSourceWithCount {
	id: string;
	name: string;
	triggerType: string;
	cronExpr: string | null;
	eventCount: number;
}

export const getEventSourcesWithCounts = query(
	'unchecked',
	async ({
		projectId,
		preselectedSourceId
	}: {
		projectId: string;
		preselectedSourceId: string | null;
	}): Promise<{ eventSources: EventSourceWithCount[]; preselectedSourceId: string | null }> => {
		// Read endpoint backing the "new workflow" form — gate by membership only.
		await requireProjectRole(projectId);
		const event = getRequestEvent();
		const db = getDb(event.platform!.env);
		const sources = await listEventSourcesForProject(db, projectId);

		let preselected = null;
		if (preselectedSourceId) {
			preselected = await getEventSourceForProject(db, preselectedSourceId, projectId);
			if (!preselected) {
				error(404, 'Event source not found');
			}
		}

		// Event counts feed the "backfill" checkbox UI — no events means there's
		// nothing to backfill against.
		const sourcesWithCount = await Promise.all(
			sources.map(async (s) => ({
				cronExpr: s.cronExpr,
				eventCount: await countEventsForSource(db, s.id),
				id: s.id,
				name: s.name,
				triggerType: s.triggerType
			}))
		);

		return {
			eventSources: sourcesWithCount,
			preselectedSourceId: preselected?.id ?? null
		};
	}
);

type CreateResult = {
	error: string;
	values: { name: string; prompt: string; sourceId: string; backfill: boolean };
};

export const createWorkflowAndGenerate = form(
	'unchecked',
	async (data: {
		projectId: string;
		name: string;
		prompt: string;
		sourceId: string;
		backfill?: string;
	}): Promise<CreateResult | undefined> => {
		const event = getRequestEvent();
		const env = event.platform!.env;
		const db = getDb(env);
		const projectId = (data.projectId ?? '').trim();
		const name = (data.name ?? '').trim();
		const prompt = (data.prompt ?? '').trim();
		const sourceId = (data.sourceId ?? '').trim();
		// Unchecked-checkbox FormData omits the field entirely; checked sends "on".
		const backfill = data.backfill === 'on';

		const values = { backfill, name, prompt, sourceId };

		if (!projectId) {
			return { error: 'Project ID is required.', values };
		}
		if (!name) {
			return { error: 'Name is required.', values };
		}
		if (!prompt) {
			return { error: 'Prompt is required.', values };
		}
		if (!sourceId) {
			return { error: 'Event source is required.', values };
		}

		const role = await requireProjectRole(projectId);
		requireCan(role, 'workflow.create');

		const source = await getEventSourceForProject(db, sourceId, projectId);
		if (!source) {
			return { error: 'Event source not found in this project.', values };
		}

		const workflowId = crypto.randomUUID();

		try {
			await createWorkflow(db, {
				eventSourceId: source.id,
				id: workflowId,
				name,
				projectId,
				prompt
			});
		} catch (err) {
			return { error: `Could not create workflow: ${errorMessage(err)}`, values };
		}

		try {
			await env.GEN_WORKFLOW.create({
				id: `gen-${workflowId}`,
				params: {
					backfill,
					name,
					prompt,
					workflowId
				}
			});
		} catch (err) {
			return { error: `Could not start generation workflow: ${errorMessage(err)}`, values };
		}

		redirect(303, `/p/${projectId}/w/${workflowId}?gen=pending`);
	}
);
