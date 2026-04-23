import { error, fail, redirect } from '@sveltejs/kit';
import type { Workflow } from '@cloudflare/workers-types';
import type { Actions, PageServerLoad } from './$types';
import { getWorkflowForProject } from '$lib/server/db/queries/workflows';
import { getCurrentVersion, getVersion, listVersions } from '$lib/server/db/queries/versions';
import { listEventsForWorkflow } from '$lib/server/db/queries/events';
import { listFailedRunsForWorkflow, listRunsForWorkflow } from '$lib/server/db/queries/runs';
import {
	getOpenNeedsAttentionSession,
	listHealSessionsForWorkflow,
	markHealSessionResolved
} from '$lib/server/db/queries/heals';
import { executeEvent, replayFailedEvents } from '$lib/server/engine';
import { tearDownWorkflow } from '$lib/server/workflows-store';
import { highlightTs } from '$lib/server/highlight';

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
		if (status.error) {
			out.error = status.error;
		}
		return out;
	} catch {
		return undefined;
	}
}

// Project ownership is enforced by /p/[projectId]/+layout.server.ts. We still
// Scope the workflow lookup by project so /p/A/w/[id-of-B-workflow] 404s.
export const load: PageServerLoad = async ({ params, url, platform }) => {
	const workflow = await getWorkflowForProject(params.workflowId, params.projectId);
	if (!workflow) {
		error(404, 'Workflow not found');
	}

	const [currentVersion, versions, events, allRuns, failedRuns, heals, needsAttention] =
		await Promise.all([
			getCurrentVersion(workflow.id),
			listVersions(workflow.id),
			listEventsForWorkflow(workflow.id, { limit: 50 }),
			listRunsForWorkflow(workflow.id),
			listFailedRunsForWorkflow(workflow.id),
			listHealSessionsForWorkflow(workflow.id),
			getOpenNeedsAttentionSession(workflow.id)
		]);
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
	if (platform) {
		const { env } = platform;

		if (workflow.currentVersionId === null) {
			const gen = await fetchInstanceStatus(env.GEN_WORKFLOW, `gen-${workflow.id}`);
			if (gen) {
				inFlight.gen = gen;
			}
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
		currentVersion,
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

async function assertOwnership(workflowId: string, projectId: string): Promise<void> {
	const wf = await getWorkflowForProject(workflowId, projectId);
	if (!wf) {
		error(404, 'Workflow not found');
	}
}

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
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return fail(500, { delete: { error: `Delete failed: ${msg}` } });
		}
		redirect(303, `/p/${params.projectId}`);
	},

	resume: async ({ params }) => {
		await assertOwnership(params.workflowId, params.projectId);
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
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return fail(500, { resume: { error: msg } });
		}
	},

	trigger: async ({ params, request }) => {
		await assertOwnership(params.workflowId, params.projectId);

		const data = await request.formData();
		const raw = (data.get('payload') ?? '').toString();

		let payload: unknown;
		try {
			payload = raw.trim() === '' ? {} : JSON.parse(raw);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return fail(400, { trigger: { error: `Invalid JSON: ${msg}` } });
		}

		try {
			const result = await executeEvent({
				payload,
				trigger: 'manual',
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
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return fail(500, { trigger: { error: msg } });
		}
	}
};
