import { listAllEventsForWorkflow } from '$lib/server/db/queries/events';
import { listFailedRunsByEvent, markRunSuperseded } from '$lib/server/db/queries/runs';
import { executeExistingEventForWorkflow } from './executor';

export interface ReplayResult {
	workflowId: string;
	attempted: number;
	ok: number;
	failed: number;
	runIds: string[];
}

export async function replayFailedEvents(workflowId: string): Promise<ReplayResult> {
	const failed = await listFailedRunsByEvent(workflowId);
	const result: ReplayResult = {
		attempted: 0,
		failed: 0,
		ok: 0,
		runIds: [],
		workflowId
	};

	for (const old of failed) {
		await markRunSuperseded(old.id);
		result.attempted += 1;
		const res = await executeExistingEventForWorkflow(old.eventId, workflowId, {
			isReplay: true,
			parentRunId: old.id
		});
		result.runIds.push(res.runId);
		if (res.status === 'ok') {
			result.ok += 1;
		} else if (res.status === 'failed') {
			result.failed += 1;
		}
	}

	return result;
}

export interface BackfillResult {
	workflowId: string;
	attempted: number;
	ok: number;
	failed: number;
	runIds: string[];
}

// Run a newly-attached workflow against every historical event on its event
// Source. Each event becomes an is_replay=true run for the new workflow, so
// The workflow inherits the source's full history. Used when a user attaches
// A parallel workflow to an existing source (graceful handover / A/B).
export async function backfillWorkflow(workflowId: string): Promise<BackfillResult> {
	const events = await listAllEventsForWorkflow(workflowId);
	const result: BackfillResult = {
		attempted: 0,
		failed: 0,
		ok: 0,
		runIds: [],
		workflowId
	};

	for (const event of events) {
		result.attempted += 1;
		try {
			const res = await executeExistingEventForWorkflow(event.id, workflowId, {
				isReplay: true
			});
			result.runIds.push(res.runId);
			if (res.status === 'ok') {
				result.ok += 1;
			} else if (res.status === 'failed') {
				result.failed += 1;
			}
		} catch (error) {
			result.failed += 1;
			console.error('[backfill] dispatch threw', {
				error: error instanceof Error ? error.message : String(error),
				eventId: event.id,
				workflowId
			});
		}
	}

	return result;
}
