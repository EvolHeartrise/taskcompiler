import { deleteWorkflow, uploadWorkflow } from '$lib/server/wfp';
import { projectIdBinding, testScriptName } from '$lib/server/workflows-store';
import type { Event, RunError, RunLogEntry, Workflow } from '$lib/server/db/types';
import { errorMessage } from '$lib/server/util';
import { invokeDispatcher } from './dispatch';
import { toRunError } from './run-error';

export interface EphemeralRunResult {
	ok: boolean;
	error?: RunError;
	logs: RunLogEntry[];
	result?: unknown;
	durationMs: number;
}

function ephemeralNonce(): string {
	const u = crypto.randomUUID().replaceAll('-', '');
	return u.slice(0, 8);
}

export async function runAgainstEventEphemeral(
	env: Env,
	sourceTs: string,
	event: Event,
	workflow: Workflow
): Promise<EphemeralRunResult> {
	const started = Date.now();
	const scriptName = testScriptName(workflow.id, ephemeralNonce());

	let uploaded = false;
	try {
		try {
			await uploadWorkflow(env, {
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

		const outcome = await invokeDispatcher(env, {
			event: {
				headers: event.headers,
				id: event.id,
				payload: event.payload,
				receivedAt: event.receivedAt,
				triggerType: event.triggerType
			},
			scriptName,
			workflow: { id: workflow.id, name: workflow.name }
		});

		const durationMs = Date.now() - started;
		if (outcome.kind === 'ok') {
			return { durationMs, logs: outcome.logs, ok: true, result: outcome.result };
		}
		return {
			durationMs,
			error: outcome.error,
			logs: outcome.kind === 'user_error' ? outcome.logs : [],
			ok: false
		};
	} finally {
		if (uploaded) {
			try {
				await deleteWorkflow(env, scriptName);
			} catch (error) {
				console.error('test-runner: failed to delete ephemeral script', {
					error: errorMessage(error),
					scriptName
				});
			}
		}
	}
}
