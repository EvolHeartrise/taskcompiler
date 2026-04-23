import { error, fail } from '@sveltejs/kit';
import type { Workflow } from '@cloudflare/workers-types';
import type { Actions, PageServerLoad } from './$types';
import { getWorkflowForUser } from '$lib/server/db/queries/workflows';
import { getCurrentVersion, getVersion, listVersions } from '$lib/server/db/queries/versions';
import { listEventsForWorkflow } from '$lib/server/db/queries/events';
import { listFailedRunsForWorkflow, listRunsForWorkflow } from '$lib/server/db/queries/runs';
import {
	getOpenNeedsAttentionSession,
	listHealSessionsForWorkflow,
	markHealSessionResolved
} from '$lib/server/db/queries/heals';
import { executeEvent, replayFailedEvents } from '$lib/server/engine';
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

export const load: PageServerLoad = async ({ params, url, platform, locals }) => {
	if (!locals.user) {
		error(401, 'unauthorized');
	}
	const workflow = await getWorkflowForUser(params.workflowId, locals.user.id);
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

async function assertOwnership(workflowId: string, userId: string | undefined): Promise<void> {
	if (!userId) {
		error(401, 'unauthorized');
	}
	const wf = await getWorkflowForUser(workflowId, userId);
	if (!wf) {
		error(404, 'Workflow not found');
	}
}

export const actions: Actions = {
	resume: async ({ params, locals }) => {
		await assertOwnership(params.workflowId, locals.user?.id);
		try {
			const session = await getOpenNeedsAttentionSession(params.workflowId);
			if (!session) {
				return fail(409, { resume: { error: 'No needs_attention session to resolve.' } });
			}
			await markHealSessionResolved(session.id);
			const replay = await replayFailedEvents(params.workflowId);
			return {
				resume: {
					ok: true,
					sessionId: session.id,
					attempted: replay.attempted,
					okCount: replay.ok,
					failedCount: replay.failed
				}
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return fail(500, { resume: { error: msg } });
		}
	},

	trigger: async ({ params, request, locals }) => {
		await assertOwnership(params.workflowId, locals.user?.id);

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
	}
};
