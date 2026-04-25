import { error, redirect } from '@sveltejs/kit';
import type { Workflow } from '@cloudflare/workers-types';
import { command, form, getRequestEvent, query } from '$app/server';
import { requireCan } from '$lib/server/auth/permissions';
import { getDb } from '$lib/server/db';
import { executeManualEvent, replayFailedEvents } from '$lib/server/engine';
import {
	getOpenNeedsAttentionSession,
	listHealSessionsForWorkflow,
	markHealSessionResolved
} from '$lib/server/db/queries/heal-sessions';
import { getProjectForUser } from '$lib/server/db/queries/projects';
import { getWorkflowForProject } from '$lib/server/db/queries/workflows';
import type { ProjectRole } from '$lib/server/db/types';
import { errorMessage } from '$lib/server/util';
import { tearDownWorkflow } from '$lib/server/workflows-store';

// Resolve the caller's role on the project (or 401/404 if they don't have
// access). Used by every mutation in this file before `requireCan`. Reads
// (`getInFlight`) intentionally skip the role lookup — they're only gated
// by membership via `getWorkflowForProject` below.
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

export const getInFlight = query(
	'unchecked',
	async ({
		projectId,
		workflowId
	}: {
		projectId: string;
		workflowId: string;
	}): Promise<InFlightInfo> => {
		const event = getRequestEvent();
		const env = event.platform!.env;
		// Belt-and-braces role check — every role can viewHistory anyway, but
		// keep the gate uniform with the rest of the file's mutations.
		const role = await requireProjectRole(projectId);
		requireCan(role, 'workflow.viewHistory');
		const workflow = await getWorkflowForProject(getDb(env), workflowId, projectId);
		if (!workflow) {
			error(404, 'Workflow not found');
		}

		const inFlight: InFlightInfo = {};

		if (workflow.currentVersionId === null) {
			const gen = await fetchInstanceStatus(env.GEN_WORKFLOW, `gen-${workflow.id}`);
			if (gen) {
				inFlight.gen = gen;
			}
		}

		const heals = await listHealSessionsForWorkflow(getDb(env), workflow.id);
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

		return inFlight;
	}
);

type DeleteResult = { ok: false; error: string };

export const deleteWorkflow = form(
	'unchecked',
	async (data: {
		projectId: string;
		workflowId: string;
		confirm_name: string;
	}): Promise<DeleteResult | undefined> => {
		const event = getRequestEvent();
		const env = event.platform!.env;
		const projectId = (data.projectId ?? '').trim();
		const workflowId = (data.workflowId ?? '').trim();
		const confirmName = data.confirm_name ?? '';

		const role = await requireProjectRole(projectId);
		requireCan(role, 'workflow.delete');

		const workflow = await getWorkflowForProject(getDb(env), workflowId, projectId);
		if (!workflow) {
			error(404, 'Workflow not found');
		}
		if (confirmName !== workflow.name) {
			return {
				ok: false,
				error: `Type the workflow name exactly to confirm. Expected "${workflow.name}".`
			};
		}

		try {
			await tearDownWorkflow(env, workflow.id);
		} catch (err) {
			return { ok: false, error: `Delete failed: ${errorMessage(err)}` };
		}
		redirect(303, `/p/${projectId}`);
	}
);

type ResumeResult =
	| { ok: true; attempted: number; okCount: number; failedCount: number; sessionId: string }
	| { ok: false; error: string };

export const resumeWorkflow = form(
	'unchecked',
	async (data: { projectId: string; workflowId: string }): Promise<ResumeResult> => {
		const event = getRequestEvent();
		const env = event.platform!.env;
		const db = getDb(env);
		const projectId = (data.projectId ?? '').trim();
		const workflowId = (data.workflowId ?? '').trim();

		const role = await requireProjectRole(projectId);
		// Resuming after needs_attention is a "run" action — same gate as
		// re-running failed events.
		requireCan(role, 'workflow.run');

		const workflow = await getWorkflowForProject(db, workflowId, projectId);
		if (!workflow) {
			error(404, 'Workflow not found');
		}
		try {
			const session = await getOpenNeedsAttentionSession(db, workflowId);
			if (!session) {
				return { ok: false, error: 'No needs_attention session to resolve.' };
			}
			await markHealSessionResolved(db, session.id);
			const replay = await replayFailedEvents(env, workflowId);
			return {
				ok: true,
				attempted: replay.attempted,
				failedCount: replay.failed,
				okCount: replay.ok,
				sessionId: session.id
			};
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
	}
);

type TriggerResult =
	| {
			ok: true;
			eventId: string;
			runId: string;
			status: string;
			result: unknown;
			error: unknown;
	  }
	| { ok: false; error: string };

export const triggerWorkflow = command(
	'unchecked',
	async ({
		projectId,
		workflowId,
		payload
	}: {
		projectId: string;
		workflowId: string;
		payload: string;
	}): Promise<TriggerResult> => {
		const event = getRequestEvent();
		const env = event.platform!.env;
		const role = await requireProjectRole(projectId);
		requireCan(role, 'workflow.run');
		const workflow = await getWorkflowForProject(getDb(env), workflowId, projectId);
		if (!workflow) {
			error(404, 'Workflow not found');
		}

		const raw = payload ?? '';
		let parsed: unknown;
		try {
			parsed = raw.trim() === '' ? {} : JSON.parse(raw);
		} catch (err) {
			return { ok: false, error: `Invalid JSON: ${errorMessage(err)}` };
		}

		try {
			const result = await executeManualEvent(env, {
				payload: parsed,
				workflowId
			});
			return {
				ok: true,
				eventId: result.eventId,
				error: result.error ?? null,
				result: result.result ?? null,
				runId: result.runId,
				status: result.status
			};
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
	}
);
