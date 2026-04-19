import { error, fail } from '@sveltejs/kit';
import type { Workflow } from '@cloudflare/workers-types';
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
import { executeEvent, replayFailedEvents } from '$lib/server/engine';

export interface InFlightStatus {
	status: string;
	error?: { name: string; message: string };
}

export interface InFlightInfo {
	gen?: InFlightStatus;
	heal?: InFlightStatus;
	healSessionId?: string;
}

async function fetchInstanceStatus(
	binding: Workflow<unknown>,
	instanceId: string
): Promise<InFlightStatus | undefined> {
	try {
		const instance = await binding.get(instanceId);
		const status = await instance.status();
		const out: InFlightStatus = { status: status.status };
		if (status.error) out.error = status.error;
		return out;
	} catch {
		return undefined;
	}
}

export const load: PageServerLoad = async ({ params, url, platform }) => {
	const workflow = await getWorkflow(params.workflowId);
	if (!workflow) error(404, 'Workflow not found');

	const [currentVersion, versions, events, allRuns, failedRuns, heals] = await Promise.all([
		getCurrentVersion(workflow.id),
		listVersions(workflow.id),
		listEventsForWorkflow(workflow.id, { limit: 50 }),
		listRunsForWorkflow(workflow.id),
		listFailedRunsForWorkflow(workflow.id),
		listHealSessionsForWorkflow(workflow.id)
	]);
	const runs = allRuns.slice(0, 50);

	const totalRuns = allRuns.length;
	const totalEvents = (await listEventsForWorkflow(workflow.id, { limit: 10000 })).length;

	const selectedVersionId = url.searchParams.get('version');
	const selectedVersion =
		(selectedVersionId ? await getVersion(selectedVersionId) : null) ?? currentVersion;

	const inFlight: InFlightInfo = {};
	if (platform) {
		const env = platform.env;

		if (workflow.currentVersionId === null) {
			const gen = await fetchInstanceStatus(env.GEN_WORKFLOW, `gen-${workflow.id}`);
			if (gen) inFlight.gen = gen;
		}

		const latestHeal = heals[0];
		if (latestHeal && latestHeal.status === 'running') {
			const heal = await fetchInstanceStatus(
				env.HEAL_WORKFLOW,
				`heal-${latestHeal.triggeringRunId}`
			);
			if (heal) {
				inFlight.heal = heal;
				inFlight.healSessionId = latestHeal.id;
			}
		}
	}

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
		inFlight,
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
			const result = await executeEvent({
				workflowId: params.workflowId,
				trigger: 'manual',
				payload
			});
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
