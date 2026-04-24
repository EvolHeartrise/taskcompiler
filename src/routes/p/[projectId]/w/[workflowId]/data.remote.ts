import { error, redirect } from '@sveltejs/kit';
import type { Workflow } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { command, form, query } from '$app/server';
import { executeManualEvent, replayFailedEvents } from '$lib/server/engine';
import {
	getOpenNeedsAttentionSession,
	listHealSessionsForWorkflow,
	markHealSessionResolved
} from '$lib/server/db/queries/heal-sessions';
import { getWorkflowForProject } from '$lib/server/db/queries/workflows';
import { errorMessage } from '$lib/server/util';
import { tearDownWorkflow } from '$lib/server/workflows-store';

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
		const workflow = await getWorkflowForProject(workflowId, projectId);
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

		const heals = await listHealSessionsForWorkflow(workflow.id);
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
		const projectId = (data.projectId ?? '').trim();
		const workflowId = (data.workflowId ?? '').trim();
		const confirmName = data.confirm_name ?? '';

		const workflow = await getWorkflowForProject(workflowId, projectId);
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
			await tearDownWorkflow(workflow.id);
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
		const projectId = (data.projectId ?? '').trim();
		const workflowId = (data.workflowId ?? '').trim();

		const workflow = await getWorkflowForProject(workflowId, projectId);
		if (!workflow) {
			error(404, 'Workflow not found');
		}
		try {
			const session = await getOpenNeedsAttentionSession(workflowId);
			if (!session) {
				return { ok: false, error: 'No needs_attention session to resolve.' };
			}
			await markHealSessionResolved(session.id);
			const replay = await replayFailedEvents(workflowId);
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
		const workflow = await getWorkflowForProject(workflowId, projectId);
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
			const result = await executeManualEvent({
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
