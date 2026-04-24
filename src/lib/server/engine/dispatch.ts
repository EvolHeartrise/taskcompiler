import type { EventTriggerType, RunError, RunLogEntry } from '$lib/server/db/types';
import { errorMessage } from '$lib/server/util';
import { classifyInfraFailure } from './run-error';

interface InvokeResponseBody {
	ok: boolean;
	result?: unknown;
	error?: RunError;
	logs?: RunLogEntry[];
}

export interface DispatchEvent {
	id: string;
	triggerType: EventTriggerType;
	receivedAt: number;
	payload: unknown;
	headers: Record<string, string>;
}

export type InvokeOutcome =
	| { kind: 'ok'; result: unknown; logs: RunLogEntry[] }
	| { kind: 'user_error'; error: RunError; logs: RunLogEntry[] }
	| { kind: 'infra_error'; error: RunError };

export async function invokeDispatcher(
	env: Env,
	args: {
		scriptName: string;
		event: DispatchEvent;
		workflow: { id: string; name: string };
	}
): Promise<InvokeOutcome> {
	let response: Response;
	try {
		response = await env.DISPATCHER.get(args.scriptName).fetch('https://workflow.invoke/', {
			body: JSON.stringify({
				event: args.event,
				workflow: args.workflow
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
	} catch (error) {
		return {
			error: classifyInfraFailure(
				'DispatchNetworkError',
				`dispatcher fetch threw: ${errorMessage(error)}`
			),
			kind: 'infra_error'
		};
	}

	if (!response.ok) {
		return {
			error: classifyInfraFailure(
				'DispatchHttpError',
				`dispatcher returned HTTP ${response.status}`
			),
			kind: 'infra_error'
		};
	}

	let body: InvokeResponseBody;
	try {
		body = (await response.json()) as InvokeResponseBody;
	} catch (error) {
		return {
			error: classifyInfraFailure(
				'InvalidDispatchBody',
				`dispatcher body parse failed: ${errorMessage(error)}`
			),
			kind: 'infra_error'
		};
	}

	const logs = body.logs ?? [];
	if (body.ok) {
		return { kind: 'ok', logs, result: body.result };
	}
	const rawErr = body.error ?? {
		message: 'workflow reported failure with no error',
		name: 'Error'
	};
	return {
		error: { ...rawErr, category: 'user_code' },
		kind: 'user_error',
		logs
	};
}
