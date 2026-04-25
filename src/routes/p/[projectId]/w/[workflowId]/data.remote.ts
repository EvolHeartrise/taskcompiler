import { error, redirect } from '@sveltejs/kit';
import type { Workflow } from '@cloudflare/workers-types';
import { command, form, getRequestEvent, query } from '$app/server';
import { requireCan } from '$lib/server/auth/permissions';
import { getDb } from '$lib/server/db';
import { executeManualEvent, replayFailedEvents, WorkflowPausedError } from '$lib/server/engine';
import {
	getOpenNeedsAttentionSession,
	listHealSessionsForWorkflow,
	markHealSessionResolved
} from '$lib/server/db/queries/heal-sessions';
import { getProjectForUser } from '$lib/server/db/queries/projects';
import {
	getWorkflowForProject,
	pauseWorkflow as pauseWorkflowRow,
	resumeWorkflow as resumeWorkflowRow
} from '$lib/server/db/queries/workflows';
import type { ProjectRole } from '$lib/server/db/types';
import { createLogger } from '$lib/server/log';
import { EVENTS } from '$lib/server/log-events';
import { errorMessage } from '$lib/server/util';
import { tearDownWorkflow } from '$lib/server/workflows-store';

const log = createLogger('workflow-mutation');

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

// Resolves an open needs_attention session and replays its failed events.
// Distinct from the pause/resume lifecycle (pauseWorkflow/resumeWorkflow
// below) which flips the workflow row's `status` column.
export const resumeNeedsAttention = form(
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
		if (workflow.status === 'paused') {
			return {
				ok: false,
				error: 'Workflow is paused. Resume it before triggering manually.'
			};
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
			if (result.runId === null) {
				// Race: pause landed between authz and the executor's re-read.
				// Surface the same user-facing message as the up-front check.
				return {
					ok: false,
					error: 'Workflow is paused. Resume it before triggering manually.'
				};
			}
			return {
				ok: true,
				eventId: result.eventId,
				error: result.error ?? null,
				result: result.result ?? null,
				runId: result.runId,
				status: result.status
			};
		} catch (err) {
			if (err instanceof WorkflowPausedError) {
				return {
					ok: false,
					error: 'Workflow is paused. Resume it before triggering manually.'
				};
			}
			return { ok: false, error: errorMessage(err) };
		}
	}
);

type PauseResult = { ok: true; alreadyPaused: boolean } | { ok: false; error: string };

export const pauseWorkflow = command(
	'unchecked',
	async ({
		projectId,
		workflowId
	}: {
		projectId: string;
		workflowId: string;
	}): Promise<PauseResult> => {
		const event = getRequestEvent();
		const env = event.platform!.env;
		const user = event.locals.user;
		if (!user) {
			error(401, 'unauthorized');
		}
		const role = await requireProjectRole(projectId);
		requireCan(role, 'workflow.edit');

		const db = getDb(env);
		const workflow = await getWorkflowForProject(db, workflowId, projectId);
		if (!workflow) {
			error(404, 'Workflow not found');
		}
		if (workflow.status === 'paused') {
			return { ok: true, alreadyPaused: true };
		}
		const changed = await pauseWorkflowRow(db, workflowId, projectId, user.id);
		log.info(EVENTS.WORKFLOW_PAUSED, {
			workflow_id: workflowId,
			paused_by: user.id
		});
		await getInFlight({ projectId, workflowId }).refresh();
		return { ok: true, alreadyPaused: !changed };
	}
);

type ResumeWorkflowResult =
	| { ok: true; alreadyActive: boolean; backfillRequested: boolean }
	| { ok: false; error: string };

export const resumeWorkflow = command(
	'unchecked',
	async ({
		projectId,
		workflowId,
		backfill
	}: {
		projectId: string;
		workflowId: string;
		backfill?: boolean;
	}): Promise<ResumeWorkflowResult> => {
		const event = getRequestEvent();
		const env = event.platform!.env;
		const user = event.locals.user;
		if (!user) {
			error(401, 'unauthorized');
		}
		const role = await requireProjectRole(projectId);
		requireCan(role, 'workflow.edit');

		const backfillRequested = backfill === true;
		const db = getDb(env);
		const workflow = await getWorkflowForProject(db, workflowId, projectId);
		if (!workflow) {
			error(404, 'Workflow not found');
		}
		if (workflow.status === 'active') {
			return { ok: true, alreadyActive: true, backfillRequested };
		}
		const changed = await resumeWorkflowRow(db, workflowId, projectId);
		log.info(EVENTS.WORKFLOW_RESUMED, {
			workflow_id: workflowId,
			resumed_by: user.id,
			backfill_requested: backfillRequested
		});
		if (backfillRequested) {
			// TASK-14: wire startBackfill(env, workflowId) here. The backfill
			// loop should enumerate events via the "events without a run"
			// query documented in task 13's report, then invoke
			// executeExistingEventForWorkflow for each.
		}
		await getInFlight({ projectId, workflowId }).refresh();
		return { ok: true, alreadyActive: !changed, backfillRequested };
	}
);
