import { deleteWorkflow, uploadWorkflow } from '$lib/server/wfp';
import { projectIdBinding, testScriptName } from '$lib/server/workflows-store';
import type { Event, RunError, RunLogEntry, Workflow } from '$lib/server/db/types';
import { createLogger } from '$lib/server/log';
import { EVENTS } from '$lib/server/log-events';
import { errorMessage } from '$lib/server/util';
import { invokeDispatcher } from './dispatch';
import { toRunError } from './run-error';

const log = createLogger('test-runner');

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
			log.info(EVENTS.TEST_RUNNER_UPLOAD_START, {
				script_name: scriptName,
				event_id: event.id,
				workflow_id: workflow.id
			});
			await uploadWorkflow(env, {
				bindings: [projectIdBinding(workflow.projectId)],
				scriptName,
				userSourceTs: sourceTs
			});
			uploaded = true;
			log.info(EVENTS.TEST_RUNNER_UPLOAD_DONE, {
				script_name: scriptName,
				event_id: event.id,
				elapsed_ms: Date.now() - started
			});
		} catch (error) {
			return {
				durationMs: Date.now() - started,
				error: toRunError(error),
				logs: [],
				ok: false
			};
		}

		log.info(EVENTS.TEST_RUNNER_INVOKE_START, {
			script_name: scriptName,
			event_id: event.id
		});
		const invokeStarted = Date.now();
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
		log.info(EVENTS.TEST_RUNNER_INVOKE_DONE, {
			script_name: scriptName,
			event_id: event.id,
			kind: outcome.kind,
			elapsed_ms: Date.now() - invokeStarted
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
				log.info(EVENTS.TEST_RUNNER_DELETE_START, { script_name: scriptName });
				await deleteWorkflow(env, scriptName);
				log.info(EVENTS.TEST_RUNNER_DELETE_DONE, { script_name: scriptName });
			} catch (error) {
				log.error(EVENTS.TEST_RUNNER_CLEANUP_FAILED, {
					error: errorMessage(error),
					script_name: scriptName
				});
			}
		}
	}
}
