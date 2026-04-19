import {
	listFailedRunsByEvent,
	markRunSuperseded,
} from "$lib/server/db/queries/runs";
import { executeExistingEvent } from "./executor";

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
		workflowId,
		attempted: 0,
		ok: 0,
		failed: 0,
		runIds: [],
	};

	for (const old of failed) {
		await markRunSuperseded(old.id);
		result.attempted += 1;
		const res = await executeExistingEvent(old.eventId, {
			isReplay: true,
			parentRunId: old.id,
		});
		result.runIds.push(res.runId);
		if (res.status === "ok") result.ok += 1;
		else if (res.status === "failed") result.failed += 1;
	}

	return result;
}
