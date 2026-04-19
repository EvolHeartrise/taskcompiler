import { CronExpressionParser } from "cron-parser";
import { executeEvent } from "$lib/server/engine";
import { getWorkflow, listWorkflows } from "$lib/server/db/queries/workflows";
import type { Workflow } from "$lib/server/db/types";

interface Scheduled {
	workflowId: string;
	cronExpr: string;
	nextFireAt: number;
	timer: ReturnType<typeof setTimeout>;
}

const scheduled = new Map<string, Scheduled>();
let started = false;

function shouldSchedule(wf: Workflow): boolean {
	if (wf.triggerType !== "cron" && wf.triggerType !== "both") return false;
	if (!wf.cronExpr || wf.cronExpr.trim().length === 0) return false;
	return true;
}

function computeNextFireAt(cronExpr: string): number | null {
	try {
		const iter = CronExpressionParser.parse(cronExpr, { currentDate: new Date() });
		return iter.next().getTime();
	} catch (err) {
		const e = err as Error;
		console.warn(`[cron] invalid expression "${cronExpr}": ${e.message}`);
		return null;
	}
}

function clearScheduled(workflowId: string): void {
	const existing = scheduled.get(workflowId);
	if (existing) {
		clearTimeout(existing.timer);
		scheduled.delete(workflowId);
	}
}

function scheduleNext(workflowId: string, cronExpr: string): void {
	clearScheduled(workflowId);
	const nextFireAt = computeNextFireAt(cronExpr);
	if (nextFireAt === null) return;
	const delay = Math.max(0, nextFireAt - Date.now());
	const timer = setTimeout(() => {
		void fire(workflowId);
	}, delay);
	scheduled.set(workflowId, { workflowId, cronExpr, nextFireAt, timer });
}

async function fire(workflowId: string): Promise<void> {
	try {
		await executeEvent({
			workflowId,
			trigger: "cron",
			payload: { firedAt: Date.now() },
		});
	} catch (err) {
		const e = err as Error;
		console.warn(`[cron] execute failed for ${workflowId}: ${e.message}`);
	}
	const current = getWorkflow(workflowId);
	if (!current || !shouldSchedule(current)) {
		clearScheduled(workflowId);
		return;
	}
	scheduleNext(workflowId, current.cronExpr as string);
}

export function startCron(): void {
	if (started) return;
	started = true;
	const workflows = listWorkflows();
	let count = 0;
	for (const wf of workflows) {
		if (!shouldSchedule(wf)) continue;
		scheduleNext(wf.id, wf.cronExpr as string);
		if (scheduled.has(wf.id)) count++;
	}
	process.stdout.write(`[cron] scheduled ${count} workflows\n`);
}

export function stopCron(): void {
	for (const s of scheduled.values()) clearTimeout(s.timer);
	scheduled.clear();
	started = false;
}

export async function rescheduleWorkflow(workflowId: string): Promise<void> {
	const wf = getWorkflow(workflowId);
	clearScheduled(workflowId);
	if (!wf) return;
	if (!shouldSchedule(wf)) return;
	scheduleNext(workflowId, wf.cronExpr as string);
}

export function listScheduled(): Array<{
	workflowId: string;
	cronExpr: string;
	nextFireAt: number;
}> {
	return Array.from(scheduled.values()).map((s) => ({
		workflowId: s.workflowId,
		cronExpr: s.cronExpr,
		nextFireAt: s.nextFireAt,
	}));
}
