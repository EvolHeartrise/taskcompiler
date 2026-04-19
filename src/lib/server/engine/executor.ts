import { createEvent, getEvent } from "$lib/server/db/queries/events";
import {
	createRun,
	finishRunFailed,
	finishRunOk,
} from "$lib/server/db/queries/runs";
import { getCurrentVersion } from "$lib/server/db/queries/versions";
import { getWorkflow } from "$lib/server/db/queries/workflows";
import type {
	EventTriggerType,
	RunError,
	RunLogEntry,
	RunStatus,
} from "$lib/server/db/types";
import { getEnv } from "$lib/server/env";

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

interface InvokeResponseBody {
	ok: boolean;
	result?: unknown;
	error?: RunError;
	logs?: RunLogEntry[];
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

		let runError: RunError | null = null;
		let runResult: unknown;
		let runLogs: RunLogEntry[] = [];

		try {
			const env = getEnv();
			const response = await env.DISPATCHER.get(version.deployPath).fetch(
				"https://workflow.invoke/",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						workflow: { id: workflow.id, name: workflow.name },
						event: {
							id: event.id,
							triggerType: event.triggerType,
							receivedAt: event.receivedAt,
							payload: event.payload,
						},
					}),
				},
			);

			const body = (await response.json()) as InvokeResponseBody;
			runLogs = body.logs ?? [];

			if (body.ok) {
				runResult = body.result;
			} else {
				runError = body.error ?? {
					name: "Error",
					message: "workflow reported failure with no error",
				};
			}
		} catch (err) {
			runError = toRunError(err);
		}

		if (runError === null) {
			await finishRunOk(run.id, runResult, runLogs);
			return {
				eventId: event.id,
				runId: run.id,
				status: "ok" as const,
				result: runResult,
			};
		}

		await finishRunFailed(run.id, runError, runLogs);
		try {
			const env = getEnv();
			await env.HEAL_WORKFLOW.create({
				id: `heal-${run.id}`,
				params: {
					workflowId: workflow.id,
					triggeringRunId: run.id,
				},
			});
		} catch (err) {
			console.error("failed to start HEAL_WORKFLOW for runId=" + run.id, err);
		}
		return {
			eventId: event.id,
			runId: run.id,
			status: "failed" as const,
			error: runError,
		};
	});
}
