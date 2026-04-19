import { createEvent, getEvent } from "$lib/server/db/queries/events";
import {
	createRun,
	finishRunFailed,
	finishRunOk,
} from "$lib/server/db/queries/runs";
import { getCurrentVersion } from "$lib/server/db/queries/versions";
import { getWorkflow } from "$lib/server/db/queries/workflows";
import type { EventTriggerType, RunError, RunStatus } from "$lib/server/db/types";
import { createContext } from "./context";
import { getRunFailedHook } from "./hooks";
import { loadWorkflowRun } from "./loader";

export interface ExecuteOptions {
	workflowId: string;
	trigger: EventTriggerType;
	payload: unknown;
	dedupKey?: string;
}

export interface ExecuteResult {
	eventId: string;
	runId: string;
	status: RunStatus;
	result?: unknown;
	error?: RunError;
}

export interface ExecuteExistingOptions {
	isReplay?: boolean;
	parentRunId?: string;
}

const chains = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = chains.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	chains.set(
		key,
		next.catch(() => {}),
	);
	return next as Promise<T>;
}

function toRunError(err: unknown): RunError {
	if (err instanceof Error) {
		const out: RunError = {
			name: err.name || "Error",
			message: err.message || String(err),
		};
		if (err.stack) out.stack = err.stack;
		return out;
	}
	if (typeof err === "object" && err !== null) {
		const anyErr = err as { name?: unknown; message?: unknown; stack?: unknown };
		const out: RunError = {
			name: typeof anyErr.name === "string" ? anyErr.name : "NonError",
			message:
				typeof anyErr.message === "string"
					? anyErr.message
					: safeStringify(err),
		};
		if (typeof anyErr.stack === "string") out.stack = anyErr.stack;
		return out;
	}
	return { name: "NonError", message: safeStringify(err) };
}

function safeStringify(v: unknown): string {
	try {
		return typeof v === "string" ? v : JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export async function executeEvent(opts: ExecuteOptions): Promise<ExecuteResult> {
	const workflow = await getWorkflow(opts.workflowId);
	if (!workflow) {
		throw new Error(`Workflow not found: ${opts.workflowId}`);
	}
	if (!workflow.currentVersionId) {
		throw new Error(`Workflow has no current version: ${opts.workflowId}`);
	}

	const event = await createEvent({
		workflowId: workflow.id,
		triggerType: opts.trigger,
		payload: opts.payload,
		dedupKey: opts.dedupKey ?? null,
	});

	return executeExistingEvent(event.id);
}

export async function executeExistingEvent(
	eventId: string,
	opts: ExecuteExistingOptions = {},
): Promise<ExecuteResult> {
	const event = await getEvent(eventId);
	if (!event) throw new Error(`Event not found: ${eventId}`);

	const workflow = await getWorkflow(event.workflowId);
	if (!workflow) throw new Error(`Workflow not found: ${event.workflowId}`);

	const version = await getCurrentVersion(workflow.id);
	if (!version) {
		throw new Error(`Workflow has no current version: ${workflow.id}`);
	}

	return withLock(workflow.id, async () => {
		const run = await createRun({
			eventId: event.id,
			workflowId: workflow.id,
			versionId: version.id,
			isReplay: opts.isReplay ?? false,
			parentRunId: opts.parentRunId ?? null,
		});

		const { ctx, getLogs } = createContext(workflow, event);

		try {
			const fn = await loadWorkflowRun(version);
			const result = await fn(event.payload, ctx);
			await finishRunOk(run.id, result, getLogs());
			return {
				eventId: event.id,
				runId: run.id,
				status: "ok" as const,
				result,
			};
		} catch (err) {
			const runError = toRunError(err);
			await finishRunFailed(run.id, runError, getLogs());
			try {
				await getRunFailedHook()({
					runId: run.id,
					workflowId: workflow.id,
					eventId: event.id,
				});
			} catch (hookErr) {
				console.error("runFailedHook threw", {
					runId: run.id,
					workflowId: workflow.id,
					eventId: event.id,
					error: hookErr,
				});
			}
			return {
				eventId: event.id,
				runId: run.id,
				status: "failed" as const,
				error: runError,
			};
		}
	});
}
