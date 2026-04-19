import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getWorkflow } from '$lib/server/db/queries/workflows';
import {
	getCurrentVersion,
	getVersion,
	listVersions
} from '$lib/server/db/queries/versions';
import { listEventsForWorkflow } from '$lib/server/db/queries/events';
import {
	listFailedRunsForWorkflow,
	listRunsForWorkflow
} from '$lib/server/db/queries/runs';
import { listHealSessionsForWorkflow } from '$lib/server/db/queries/heals';
import { triggerManual } from '$lib/server/triggers/manual';
import { replayFailedEvents } from '$lib/server/engine/replay';

export const load: PageServerLoad = async ({ params, url }) => {
	const workflow = getWorkflow(params.workflowId);
	if (!workflow) error(404, 'Workflow not found');

	const currentVersion = getCurrentVersion(workflow.id);
	const versions = listVersions(workflow.id);
	const events = listEventsForWorkflow(workflow.id, { limit: 50 });
	const runs = listRunsForWorkflow(workflow.id).slice(0, 50);
	const failedRuns = listFailedRunsForWorkflow(workflow.id);
	const heals = listHealSessionsForWorkflow(workflow.id);

	const totalRuns = listRunsForWorkflow(workflow.id).length;
	const totalEvents = listEventsForWorkflow(workflow.id, { limit: 10000 }).length;

	const selectedVersionId = url.searchParams.get('version');
	const selectedVersion =
		(selectedVersionId && getVersion(selectedVersionId)) || currentVersion;

	return {
		workflow,
		currentVersion,
		selectedVersion,
		versions,
		events,
		runs,
		failedRuns,
		heals,
		stats: {
			totalEvents,
			totalRuns,
			totalFailed: failedRuns.length,
			totalHeals: heals.length
		},
		origin: url.origin
	};
};

export const actions: Actions = {
	trigger: async ({ params, request }) => {
		const data = await request.formData();
		const raw = (data.get('payload') ?? '').toString();

		let payload: unknown;
		try {
			payload = raw.trim() === '' ? {} : JSON.parse(raw);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return fail(400, { trigger: { error: `Invalid JSON: ${msg}` } });
		}

		try {
			const result = await triggerManual(params.workflowId, payload);
			return {
				trigger: {
					ok: true,
					eventId: result.eventId,
					runId: result.runId,
					status: result.status,
					result: result.result ?? null,
					error: result.error ?? null
				}
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return fail(500, { trigger: { error: msg } });
		}
	},

	replay: async ({ params }) => {
		try {
			const result = await replayFailedEvents(params.workflowId);
			return {
				replay: {
					ok: true,
					attempted: result.attempted,
					okCount: result.ok,
					failedCount: result.failed
				}
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return fail(500, { replay: { error: msg } });
		}
	}
};
