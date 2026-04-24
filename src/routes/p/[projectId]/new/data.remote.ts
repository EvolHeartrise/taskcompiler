import { error, redirect } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { form, query } from '$app/server';
import {
	getEventSourceForProject,
	listEventSourcesForProject
} from '$lib/server/db/queries/event-sources';
import { countEventsForSource } from '$lib/server/db/queries/events';
import { createWorkflow } from '$lib/server/db/queries/workflows';
import { errorMessage } from '$lib/server/util';

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
		const sources = await listEventSourcesForProject(projectId);

		let preselected = null;
		if (preselectedSourceId) {
			preselected = await getEventSourceForProject(preselectedSourceId, projectId);
			if (!preselected) {
				error(404, 'Event source not found');
			}
		}

		// Event counts feed the "backfill" checkbox UI — no events means there's
		// nothing to backfill against.
		const sourcesWithCount = await Promise.all(
			sources.map(async (s) => ({
				cronExpr: s.cronExpr,
				eventCount: await countEventsForSource(s.id),
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

		const source = await getEventSourceForProject(sourceId, projectId);
		if (!source) {
			return { error: 'Event source not found in this project.', values };
		}

		const workflowId = crypto.randomUUID();

		try {
			await createWorkflow({
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
