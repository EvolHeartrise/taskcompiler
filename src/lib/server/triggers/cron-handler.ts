import { CronExpressionParser } from 'cron-parser';
import { listCronWorkflows, markWorkflowFired } from '$lib/server/db/queries/workflows';
import { executeEvent } from '$lib/server/engine';

export interface CronTickResult {
	scanned: number;
	fired: Array<{ workflowId: string; runId: string; status: string }>;
	skipped: Array<{ workflowId: string; reason: string }>;
}

// Fires AT MOST ONCE per workflow per tick. If multiple cron intervals were
// missed (e.g. the control plane was down), only the next tick will fire — we
// do NOT backfill missed intervals here. Intentional catch-up requires a
// separate pass.
export async function handleCronTick(now: number = Date.now()): Promise<CronTickResult> {
	const workflows = await listCronWorkflows();
	const result: CronTickResult = {
		scanned: workflows.length,
		fired: [],
		skipped: []
	};

	for (const workflow of workflows) {
		const expr = workflow.cronExpr;
		if (!expr) {
			result.skipped.push({ workflowId: workflow.id, reason: 'missing cron expression' });
			continue;
		}

		let nextDue: number;
		try {
			const iter = CronExpressionParser.parse(expr, {
				currentDate: workflow.lastFiredAt > 0 ? new Date(workflow.lastFiredAt) : new Date(0),
				tz: 'UTC'
			});
			nextDue = iter.next().getTime();
		} catch (err) {
			result.skipped.push({
				workflowId: workflow.id,
				reason: `invalid cron: ${expr}${err instanceof Error ? ` (${err.message})` : ''}`
			});
			continue;
		}

		if (nextDue > now) {
			result.skipped.push({ workflowId: workflow.id, reason: 'not due yet' });
			continue;
		}

		try {
			await markWorkflowFired(workflow.id, now);
			const exec = await executeEvent({
				workflowId: workflow.id,
				trigger: 'cron',
				payload: { firedAt: now }
			});
			result.fired.push({
				workflowId: workflow.id,
				runId: exec.runId,
				status: exec.status
			});
		} catch (err) {
			result.skipped.push({
				workflowId: workflow.id,
				reason: `error: ${err instanceof Error ? err.message : String(err)}`
			});
		}
	}

	return result;
}
