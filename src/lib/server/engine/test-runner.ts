import { getEnv } from '$lib/server/env';
import { deleteWorkflow, uploadWorkflow } from '$lib/server/wfp';
import { projectIdBinding, testScriptName } from '$lib/server/workflows-store';
import type { Event, RunError, RunLogEntry, Workflow } from '$lib/server/db/types';

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
			message: err.message || String(err),
			name: err.name || 'Error'
		};
		if (err.stack) {
			out.stack = err.stack;
		}
		return out;
	}
	if (typeof err === 'object' && err !== null) {
		const anyErr = err as { name?: unknown; message?: unknown; stack?: unknown };
		const out: RunError = {
			message: typeof anyErr.message === 'string' ? anyErr.message : safeStringify(err),
			name: typeof anyErr.name === 'string' ? anyErr.name : 'NonError'
		};
		if (typeof anyErr.stack === 'string') {
			out.stack = anyErr.stack;
		}
		return out;
	}
	return { message: safeStringify(err), name: 'NonError' };
}

function safeStringify(v: unknown): string {
	try {
		return typeof v === 'string' ? v : JSON.stringify(v);
	} catch {
		return String(v);
	}
}

function ephemeralNonce(): string {
	const u = crypto.randomUUID().replaceAll('-', '');
	return u.slice(0, 8);
}

export async function runAgainstEventEphemeral(
	sourceTs: string,
	event: Event,
	workflow: Workflow
): Promise<EphemeralRunResult> {
	const started = Date.now();
	const scriptName = testScriptName(workflow.id, ephemeralNonce());

	let uploaded = false;
	try {
		try {
			await uploadWorkflow({
				bindings: [projectIdBinding(workflow.projectId)],
				scriptName,
				userSourceTs: sourceTs
			});
			uploaded = true;
		} catch (error) {
			return {
				durationMs: Date.now() - started,
				error: toRunError(error),
				logs: [],
				ok: false
			};
		}

		const env = getEnv();
		let response: Awaited<ReturnType<ReturnType<typeof env.DISPATCHER.get>['fetch']>>;
		try {
			response = await env.DISPATCHER.get(scriptName).fetch('https://workflow.invoke/', {
				body: JSON.stringify({
					event: {
						headers: event.headers,
						id: event.id,
						payload: event.payload,
						receivedAt: event.receivedAt,
						triggerType: event.triggerType
					},
					workflow: { id: workflow.id, name: workflow.name }
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});
		} catch (error) {
			return {
				durationMs: Date.now() - started,
				error: toRunError(error),
				logs: [],
				ok: false
			};
		}

		let body: InvokeResponseBody;
		try {
			body = (await response.json()) as InvokeResponseBody;
		} catch (error) {
			return {
				durationMs: Date.now() - started,
				error: toRunError(error),
				logs: [],
				ok: false
			};
		}

		const logs = body.logs ?? [];
		if (body.ok) {
			return {
				durationMs: Date.now() - started,
				logs,
				ok: true,
				result: body.result
			};
		}
		return {
			durationMs: Date.now() - started,
			error: body.error ?? {
				message: 'workflow reported failure with no error',
				name: 'Error'
			},
			logs,
			ok: false
		};
	} finally {
		if (uploaded) {
			try {
				await deleteWorkflow(scriptName);
			} catch (error) {
				console.error('test-runner: failed to delete ephemeral script', {
					error: error instanceof Error ? error.message : String(error),
					scriptName
				});
			}
		}
	}
}
