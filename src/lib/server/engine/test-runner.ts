import { getEnv } from "$lib/server/env";
import { uploadWorkflow, deleteWorkflow } from "$lib/server/wfp";
import { testScriptName } from "$lib/server/workflows-store";
import type { Event, RunError, RunLogEntry, Workflow } from "$lib/server/db/types";

export interface EphemeralRunResult {
	ok: boolean;
	error?: RunError;
	logs: RunLogEntry[];
	result?: unknown;
	durationMs: number;
}

interface InvokeResponseBody {
	ok: boolean;
	result?: unknown;
	error?: RunError;
	logs?: RunLogEntry[];
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

function ephemeralNonce(): string {
	const u = crypto.randomUUID().replace(/-/g, "");
	return u.slice(0, 8);
}

export async function runAgainstEventEphemeral(
	sourceTs: string,
	event: Event,
	workflow: Workflow,
): Promise<EphemeralRunResult> {
	const started = Date.now();
	const scriptName = testScriptName(workflow.id, ephemeralNonce());

	let uploaded = false;
	try {
		try {
			await uploadWorkflow({ scriptName, userSourceTs: sourceTs });
			uploaded = true;
		} catch (err) {
			return {
				ok: false,
				error: toRunError(err),
				logs: [],
				durationMs: Date.now() - started,
			};
		}

		const env = getEnv();
		let response: Awaited<ReturnType<ReturnType<typeof env.DISPATCHER.get>["fetch"]>>;
		try {
			response = await env.DISPATCHER.get(scriptName).fetch(
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
		} catch (err) {
			return {
				ok: false,
				error: toRunError(err),
				logs: [],
				durationMs: Date.now() - started,
			};
		}

		let body: InvokeResponseBody;
		try {
			body = (await response.json()) as InvokeResponseBody;
		} catch (err) {
			return {
				ok: false,
				error: toRunError(err),
				logs: [],
				durationMs: Date.now() - started,
			};
		}

		const logs = body.logs ?? [];
		if (body.ok) {
			return {
				ok: true,
				result: body.result,
				logs,
				durationMs: Date.now() - started,
			};
		}
		return {
			ok: false,
			error: body.error ?? {
				name: "Error",
				message: "workflow reported failure with no error",
			},
			logs,
			durationMs: Date.now() - started,
		};
	} finally {
		if (uploaded) {
			try {
				await deleteWorkflow(scriptName);
			} catch (err) {
				console.error("test-runner: failed to delete ephemeral script", {
					scriptName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
}
