import { getDb } from '$lib/server/db';
import { listAllEventsForWorkflow } from '$lib/server/db/queries/events';
import { listFailedRunsByEvent, markRunSuperseded } from '$lib/server/db/queries/runs';
import { createLogger } from '$lib/server/log';
import { EVENTS } from '$lib/server/log-events';
import { errorMessage } from '$lib/server/util';
import { type ExecuteResult, executeExistingEventForWorkflow } from './executor';

const log = createLogger('replay');

export interface DispatchTally {
	workflowId: string;
	attempted: number;
	ok: number;
	failed: number;
	runIds: string[];
}

async function dispatchAndTally<T>(
	workflowId: string,
	items: T[],
	dispatch: (item: T) => Promise<ExecuteResult>
): Promise<DispatchTally> {
	const result: DispatchTally = {
		attempted: 0,
		failed: 0,
		ok: 0,
		runIds: [],
		workflowId
	};
	for (const item of items) {
		result.attempted += 1;
		try {
			const res = await dispatch(item);
			result.runIds.push(res.runId);
			if (res.status === 'ok') {
				result.ok += 1;
			} else if (res.status === 'failed') {
				result.failed += 1;
			}
		} catch (error) {
			result.failed += 1;
			log.error(EVENTS.DISPATCH_TALLY_THREW, {
				error: errorMessage(error),
				workflow_id: workflowId
			});
		}
	}
	return result;
}

export async function replayFailedEvents(env: Env, workflowId: string): Promise<DispatchTally> {
	const db = getDb(env);
	const failed = await listFailedRunsByEvent(db, workflowId);
	return dispatchAndTally(workflowId, failed, async (old) => {
		await markRunSuperseded(db, old.id);
		return executeExistingEventForWorkflow(env, old.eventId, workflowId, {
			isReplay: true,
			parentRunId: old.id
		});
	});
}

export async function backfillWorkflow(env: Env, workflowId: string): Promise<DispatchTally> {
	const events = await listAllEventsForWorkflow(getDb(env), workflowId);
	return dispatchAndTally(workflowId, events, (event) =>
		executeExistingEventForWorkflow(env, event.id, workflowId, { isReplay: true })
	);
}
