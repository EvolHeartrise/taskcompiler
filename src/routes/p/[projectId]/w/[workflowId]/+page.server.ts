import { error, fail, redirect } from '@sveltejs/kit';
import type { Workflow } from '@cloudflare/workers-types';
import type { Actions, PageServerLoad } from './$types';
import { getWorkflowForProject } from '$lib/server/db/queries/workflows';
import { getEventSource } from '$lib/server/db/queries/event-sources';
import { getCurrentVersion, getVersion, listVersions } from '$lib/server/db/queries/versions';
import { listEventsForWorkflow } from '$lib/server/db/queries/events';
import { listFailedRunsForWorkflow, listRunsForWorkflow } from '$lib/server/db/queries/runs';
import {
	getOpenNeedsAttentionSession,
	listHealSessionsForWorkflow,
	markHealSessionResolved
} from '$lib/server/db/queries/heal-sessions';
import { executeManualEvent, replayFailedEvents } from '$lib/server/engine';
import { tearDownWorkflow } from '$lib/server/workflows-store';
import { highlightTs } from '$lib/server/highlight';
import { getEnv } from '$lib/server/env';
import { errorMessage } from '$lib/server/util';

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
	binding: Workflow,
	instanceId: string
): Promise<InFlightStatus | undefined> {
	try {
		const instance = await binding.get(instanceId);
		const status = await instance.status();
		const out: InFlightStatus = { status: status.status };
		if (status.error) {
			out.error = status.error;
		}
		return out;
	} catch {
		return undefined;
	}
}

// Layout enforces project ownership; the workflow lookup is still scoped by
// project so /p/A/w/[id-of-B-workflow] 404s rather than leaking.
export const load: PageServerLoad = async ({ params, url }) => {
	const workflow = await getWorkflowForProject(params.workflowId, params.projectId);
	if (!workflow) {
		error(404, 'Workflow not found');
	}

	const [
		eventSource,
		currentVersion,
		versions,
		events,
		allRuns,
		failedRuns,
		heals,
		needsAttention
	] = await Promise.all([
		getEventSource(workflow.eventSourceId),
		getCurrentVersion(workflow.id),
		listVersions(workflow.id),
		listEventsForWorkflow(workflow.id, { limit: 50 }),
		listRunsForWorkflow(workflow.id),
		listFailedRunsForWorkflow(workflow.id),
		listHealSessionsForWorkflow(workflow.id),
		getOpenNeedsAttentionSession(workflow.id)
	]);
	if (!eventSource) {
		// Shouldn't happen — cascade would have wiped the workflow. Treat as 404.
		error(404, 'Event source for this workflow was deleted');
	}
	const runs = allRuns.slice(0, 50);

	const totalRuns = allRuns.length;
	const totalEvents = (await listEventsForWorkflow(workflow.id, { limit: 10_000 })).length;

	const selectedVersionId = url.searchParams.get('version');
	const selectedVersion =
		(selectedVersionId ? await getVersion(selectedVersionId) : null) ?? currentVersion;

	const selectedVersionSourceHtml = selectedVersion
		? await highlightTs(selectedVersion.sourceTs)
		: null;

	const inFlight: InFlightInfo = {};
	const env = getEnv();

	if (workflow.currentVersionId === null) {
		const gen = await fetchInstanceStatus(env.GEN_WORKFLOW, `gen-${workflow.id}`);
		if (gen) {
			inFlight.gen = gen;
		}
	}

	const latestHeal = heals[0];
	if (latestHeal && latestHeal.status === 'running') {
		const heal = await fetchInstanceStatus(env.HEAL_WORKFLOW, `heal-${latestHeal.triggeringRunId}`);
		if (heal) {
			inFlight.heal = heal;
			inFlight.healSessionId = latestHeal.id;
		}
	}

	return {
		currentVersion,
		eventSource,
		events,
		failedRuns,
		heals,
		inFlight,
		needsAttention,
		origin: url.origin,
		runs,
		selectedVersion,
		selectedVersionSourceHtml,
		stats: {
			totalEvents,
			totalFailed: failedRuns.length,
			totalHeals: heals.length,
			totalRuns
		},
		versions,
		workflow
	};
};

export const actions: Actions = {
	delete: async ({ params, request }) => {
		const workflow = await getWorkflowForProject(params.workflowId, params.projectId);
		if (!workflow) {
			error(404, 'Workflow not found');
		}

		const data = await request.formData();
		const confirmName = (data.get('confirm_name') ?? '').toString();
		if (confirmName !== workflow.name) {
			return fail(400, {
				delete: {
					error: `Type the workflow name exactly to confirm. Expected "${workflow.name}".`
				}
			});
		}

		try {
			await tearDownWorkflow(workflow.id);
		} catch (err) {
			return fail(500, { delete: { error: `Delete failed: ${errorMessage(err)}` } });
		}
		redirect(303, `/p/${params.projectId}`);
	},

	resume: async ({ params }) => {
		const workflow = await getWorkflowForProject(params.workflowId, params.projectId);
		if (!workflow) {
			error(404, 'Workflow not found');
		}
		try {
			const session = await getOpenNeedsAttentionSession(params.workflowId);
			if (!session) {
				return fail(409, { resume: { error: 'No needs_attention session to resolve.' } });
			}
			await markHealSessionResolved(session.id);
			const replay = await replayFailedEvents(params.workflowId);
			return {
				resume: {
					attempted: replay.attempted,
					failedCount: replay.failed,
					ok: true,
					okCount: replay.ok,
					sessionId: session.id
				}
			};
		} catch (err) {
			return fail(500, { resume: { error: errorMessage(err) } });
		}
	},

	trigger: async ({ params, request }) => {
		const workflow = await getWorkflowForProject(params.workflowId, params.projectId);
		if (!workflow) {
			error(404, 'Workflow not found');
		}

		const data = await request.formData();
		const raw = (data.get('payload') ?? '').toString();

		let payload: unknown;
		try {
			payload = raw.trim() === '' ? {} : JSON.parse(raw);
		} catch (err) {
			return fail(400, { trigger: { error: `Invalid JSON: ${errorMessage(err)}` } });
		}

		try {
			const result = await executeManualEvent({
				payload,
				workflowId: params.workflowId
			});
			return {
				trigger: {
					error: result.error ?? null,
					eventId: result.eventId,
					ok: true,
					result: result.result ?? null,
					runId: result.runId,
					status: result.status
				}
			};
		} catch (err) {
			return fail(500, { trigger: { error: errorMessage(err) } });
		}
	}
};
