// Tiny structured JSON logger — one `console.<level>` call per event, each a
// single-line JSON object so Cloudflare's Workers Logs pipeline ingests it as
// structured data (searchable via `$.<field>` in the Observability UI and
// API). No runtime deps — this file is ~60 lines on purpose.
//
// The factory returns four level methods plus `child()`. The module-level
// AsyncLocalStorage-backed context (see `log-context.ts`) is merged into
// every emitted line, so entry points open a context once and every log
// call inside inherits request_id / workflow_instance_id / step etc.

import { getLogContext } from './log-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
	debug: (event: string, fields?: LogFields) => void;
	info: (event: string, fields?: LogFields) => void;
	warn: (event: string, fields?: LogFields) => void;
	error: (event: string, fields?: LogFields) => void;
	child: (extra: LogFields) => Logger;
}

// Allowlist for field names that otherwise match our secret regex but are
// stable identifiers used throughout the event schema. Extend sparingly.
const SECRET_KEY_ALLOWLIST = new Set<string>([
	'request_id',
	'run_id',
	'runId',
	'workflow_id',
	'workflowId',
	'heal_session_id',
	'healSessionId',
	'tick_id',
	'event_id',
	'eventId',
	'version_id',
	'versionId'
]);

const SECRET_KEY_RE =
	/token|secret|password|api[_-]?key|bearer|cookie|authorization|magic[_-]?link/i;

function isSecretKey(key: string): boolean {
	if (SECRET_KEY_ALLOWLIST.has(key)) {
		return false;
	}
	return SECRET_KEY_RE.test(key);
}

// Walks `value` and replaces values under known-secret keys with '<redacted>'.
// Preserves shape so the rest of the log line remains useful. Returns a new
// structure — never mutates the input.
export function redact(value: unknown, depth = 0): unknown {
	if (depth > 8) {
		return '<depth-limit>';
	}
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((v) => redact(v, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[k] = isSecretKey(k) ? '<redacted>' : redact(v, depth + 1);
	}
	return out;
}

function emit(
	level: LogLevel,
	context: string,
	event: string,
	fields: LogFields | undefined
): void {
	const ctxFields = getLogContext();
	const line: Record<string, unknown> = {
		level,
		ts: Date.now(),
		context,
		event,
		...ctxFields,
		...(fields ? (redact(fields) as LogFields) : {})
	};
	const serialized = JSON.stringify(line);
	if (level === 'error') {
		console.error(serialized);
	} else if (level === 'warn') {
		console.warn(serialized);
	} else if (level === 'debug') {
		console.debug(serialized);
	} else {
		console.log(serialized);
	}
}

function buildLogger(context: string, baseFields: LogFields): Logger {
	const merge = (fields?: LogFields): LogFields | undefined => {
		if (!fields) {
			return Object.keys(baseFields).length > 0 ? baseFields : undefined;
		}
		return { ...baseFields, ...fields };
	};
	return {
		debug: (event, fields) => emit('debug', context, event, merge(fields)),
		info: (event, fields) => emit('info', context, event, merge(fields)),
		warn: (event, fields) => emit('warn', context, event, merge(fields)),
		error: (event, fields) => emit('error', context, event, merge(fields)),
		child: (extra) => buildLogger(context, { ...baseFields, ...extra })
	};
}

export function createLogger(context: string): Logger {
	return buildLogger(context, {});
}
