#!/usr/bin/env bun
//
// Runely Workers Observability CLI — queries the Workers Logs pipeline via
// the Cloudflare REST API so agents and humans can inspect the deployed
// worker without clicking through the dashboard.
//
// Every structured log line emitted by src/lib/server/log.ts (and every
// user-script log forwarded from templates/workflow-worker/ctx.ts) lands
// in the same pipeline and is queryable by the fields below.
//
// SETUP (one-time):
//   1. Create a Cloudflare API token at
//      https://dash.cloudflare.com/profile/api-tokens with scopes:
//        - Account → Workers Observability → Read (on the account
//          owning runely-workflows).
//   2. Export it: `export CLOUDFLARE_API_TOKEN=...`
//   3. Export the account id: `export CLOUDFLARE_ACCOUNT_ID=...`
//      (same value as in wrangler secrets). Alternatively, put both in a
//      local `.dev.vars` file at the repo root — this script will pick them
//      up from there as a fallback.
//
// USAGE:
//   bun scripts/logs.ts [flags]
//
// Flags:
//   --run <id>              Filter to a specific run_id
//   --heal <id>             Filter to a specific heal_session_id
//   --workflow <id>         Filter to a specific workflow_id
//   --request <id>          Filter to a specific request_id
//   --event <name>          Filter to a specific event name (e.g. heal.claimed)
//   --level <lvl>           Minimum level: debug|info|warn|error (default info)
//   --since <iso|dur>       Start timestamp. ISO-8601 ("2026-04-23T10:00:00Z")
//                           or a duration suffixed with s/m/h/d (default 15m).
//   --until <iso>           End timestamp (default: now)
//   --limit <n>             Max lines returned (default 500)
//   --format <jsonl|pretty> Output format (default jsonl)
//   --dry-run               Print the query body that would be POSTed, don't send
//   --help, -h              Print this help and exit
//
// EXAMPLES:
//   # Last 15 minutes of info-or-higher lines, JSONL to stdout:
//   bun scripts/logs.ts
//
//   # Everything for a specific run, pretty-printed:
//   bun scripts/logs.ts --run a1b2... --since 1h --format pretty
//
//   # All errors in the last hour (including user-script errors):
//   bun scripts/logs.ts --since 1h --level error --limit 200
//
// OUTPUT:
//   Each JSONL line is the raw log event, e.g.
//     {"ts":...,"level":"info","context":"executor","event":"run.started",
//      "run_id":"...","workflow_id":"...",...}
//   Pretty format collapses to "<iso>  <level>  <event>  key=v ..." lines.
//
// FIELD MODEL:
//   Structured lines emitted by src/lib/server/log.ts are visible in results
//   under `source.*` (our logger fields: level, context, event, run_id,
//   workflow_id, heal_session_id, request_id, ts, plus any custom fields
//   passed to the log call). For FILTERING, those fields are addressed by
//   BARE NAME (e.g. `event`, `run_id`) — the `source.*` prefix is the result
//   projection and is NOT filterable. Cloudflare-injected metadata uses the
//   `$metadata.*` / `$workers.*` prefixes and stays filterable that way.
//   All --run / --heal / --workflow / --request / --event / --level flags
//   therefore match only events whose structured payload carries those keys;
//   Cloudflare invocation summaries are automatically excluded.
//
// EXIT CODES: 0 on success, 1 on config error, 2 on API error.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface Args {
	run?: string;
	heal?: string;
	workflow?: string;
	request?: string;
	event?: string;
	level: 'debug' | 'info' | 'warn' | 'error';
	since: string; // ISO or duration
	until?: string;
	limit: number;
	format: 'jsonl' | 'pretty';
	dryRun: boolean;
}

function usage(exitCode: number): never {
	const topComment = readFileSync(new URL(import.meta.url), 'utf8')
		.split('\n')
		.filter((l) => l.startsWith('//') || l === '')
		.slice(0, 60)
		.join('\n');
	process.stdout.write(`${topComment}\n`);
	process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
	const out: Args = {
		level: 'info',
		since: '15m',
		limit: 500,
		format: 'jsonl',
		dryRun: false
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = argv[i + 1];
		if (a === '--help' || a === '-h') {
			usage(0);
		} else if (a === '--run' && next) {
			out.run = next;
			i++;
		} else if (a === '--heal' && next) {
			out.heal = next;
			i++;
		} else if (a === '--workflow' && next) {
			out.workflow = next;
			i++;
		} else if (a === '--request' && next) {
			out.request = next;
			i++;
		} else if (a === '--event' && next) {
			out.event = next;
			i++;
		} else if (a === '--level' && next) {
			if (next !== 'debug' && next !== 'info' && next !== 'warn' && next !== 'error') {
				die(`invalid --level: ${next}`, 1);
			}
			out.level = next;
			i++;
		} else if (a === '--since' && next) {
			out.since = next;
			i++;
		} else if (a === '--until' && next) {
			out.until = next;
			i++;
		} else if (a === '--limit' && next) {
			const n = Number(next);
			if (!Number.isFinite(n) || n <= 0) {
				die(`invalid --limit: ${next}`, 1);
			}
			out.limit = Math.floor(n);
			i++;
		} else if (a === '--format' && next) {
			if (next !== 'jsonl' && next !== 'pretty') {
				die(`invalid --format: ${next}`, 1);
			}
			out.format = next;
			i++;
		} else if (a === '--dry-run') {
			out.dryRun = true;
		} else if (a && a.startsWith('--')) {
			die(`unknown flag: ${a}`, 1);
		}
	}
	return out;
}

function die(msg: string, code: number): never {
	process.stderr.write(`error: ${msg}\n`);
	process.exit(code);
}

// Parses an ISO-8601 timestamp OR a short duration like "15m"/"2h"/"1d" into
// an epoch-millisecond. Durations are relative to `nowMs`.
function parseTimestamp(s: string, nowMs: number): number {
	const durMatch = /^(\d+)\s*(s|m|h|d)$/.exec(s);
	if (durMatch) {
		const n = Number(durMatch[1]);
		const unit = durMatch[2];
		const mult =
			unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
		return nowMs - n * mult;
	}
	const t = Date.parse(s);
	if (!Number.isFinite(t)) {
		die(`invalid timestamp: ${s}`, 1);
	}
	return t;
}

// Looks up CF credentials from (in order) process env, then a repo-local
// `.dev.vars` file at cwd (same format wrangler uses).
function loadCredentials(): { accountId: string; token: string } {
	let accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
	let token = process.env.CLOUDFLARE_API_TOKEN ?? '';
	if (!accountId || !token) {
		const devVars = path.resolve(process.cwd(), '.dev.vars');
		if (existsSync(devVars)) {
			const text = readFileSync(devVars, 'utf8');
			for (const raw of text.split('\n')) {
				const line = raw.trim();
				if (!line || line.startsWith('#')) {
					continue;
				}
				const eq = line.indexOf('=');
				if (eq === -1) {
					continue;
				}
				const k = line.slice(0, eq).trim();
				let v = line.slice(eq + 1).trim();
				if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
					v = v.slice(1, -1);
				}
				if (k === 'CLOUDFLARE_ACCOUNT_ID' && !accountId) {
					accountId = v;
				}
				if (k === 'CLOUDFLARE_API_TOKEN' && !token) {
					token = v;
				}
			}
		}
	}
	if (!accountId || !token) {
		die(
			'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set (env or .dev.vars). See docs/logging.md.',
			1
		);
	}
	return { accountId, token };
}

// Builds the Cloudflare Workers Observability telemetry query body. The API
// shape is documented at
// https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
// We restrict by script-tag (worker name) and tail-style filters. Any field
// emitted by our logger ("run_id", "heal_session_id", etc.) is queryable
// as a `$metadata.*` filter via the `filters` array.
function buildQueryBody(args: Args): Record<string, unknown> {
	const now = Date.now();
	const from = parseTimestamp(args.since, now);
	const to = args.until ? parseTimestamp(args.until, now) : now;

	type SimpleFilter = { key: string; operation: string; type: string; value: string };
	type GroupFilter = { kind: 'group'; filterCombination: 'and' | 'or'; filters: SimpleFilter[] };
	type Filter = SimpleFilter | GroupFilter;

	const filters: Filter[] = [];
	const pushEq = (key: string, value: string): void => {
		filters.push({ key, operation: 'eq', type: 'string', value });
	};
	// Structured-JSON payload fields are filterable by BARE key (no prefix).
	// `source.*` is only the viewable projection — filtering against
	// `source.event` etc. returns zero. Cloudflare metadata uses `$metadata.*`
	// / `$workers.*` and our logger fields use the bare names.
	if (args.run) {
		pushEq('run_id', args.run);
	}
	if (args.heal) {
		pushEq('heal_session_id', args.heal);
	}
	if (args.workflow) {
		pushEq('workflow_id', args.workflow);
	}
	if (args.request) {
		pushEq('request_id', args.request);
	}
	if (args.event) {
		pushEq('event', args.event);
	}

	const levelOrder = { debug: 0, info: 1, warn: 2, error: 3 } as const;
	const minLevel = levelOrder[args.level];
	const allowedLevels = (['debug', 'info', 'warn', 'error'] as const).filter(
		(l) => levelOrder[l] >= minLevel
	);
	// The telemetry API's filter schema is a union: each entry is either a
	// simple { key, operation, type, value: string } or a group
	// { kind: 'group', filterCombination, filters: [...] }. Multi-value OR
	// must be expressed as the group form — a simple filter's `value` can't
	// be an array.
	if (allowedLevels.length > 0 && allowedLevels.length < 4) {
		filters.push({
			kind: 'group',
			filterCombination: 'or',
			filters: allowedLevels.map((l) => ({
				key: 'level',
				operation: 'eq',
				type: 'string',
				value: l
			}))
		});
	}

	return {
		queryId: 'runely-logs-cli',
		parameters: {
			datasets: ['cloudflare-workers'],
			filters,
			limit: args.limit,
			orderBy: { type: 'calculation', value: 'timestamp desc' }
		},
		timeframe: { from, to },
		view: 'events'
	};
}

interface TelemetryEvent {
	timestamp?: number;
	$metadata?: Record<string, unknown>;
	source?: Record<string, unknown>;
	[key: string]: unknown;
}

interface TelemetryResponse {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	result?: {
		events?: { events?: TelemetryEvent[] } | TelemetryEvent[];
	};
}

async function runQuery(
	accountId: string,
	token: string,
	body: unknown
): Promise<TelemetryEvent[]> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	const text = await res.text();
	if (!res.ok) {
		die(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 800)}`, 2);
	}
	let parsed: TelemetryResponse;
	try {
		parsed = JSON.parse(text) as TelemetryResponse;
	} catch (error) {
		die(`invalid JSON response: ${String(error)}\nraw: ${text.slice(0, 800)}`, 2);
	}
	if (parsed.success === false) {
		const msg = parsed.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') ?? text;
		die(`Cloudflare API error: ${msg}`, 2);
	}
	const events = parsed.result?.events;
	if (!events) {
		return [];
	}
	if (Array.isArray(events)) {
		return events;
	}
	return events.events ?? [];
}

function extractPayload(evt: TelemetryEvent): Record<string, unknown> {
	// Structured log lines emitted by src/lib/server/log.ts land with their
	// JSON object pre-parsed under `source.*` — prefer that when present.
	// Fall back to `$metadata` + `message` for Cloudflare-injected events
	// (invocation summaries, scheduled triggers, etc.) that don't have our
	// logger's envelope.
	const src = evt.source;
	if (src && typeof src === 'object' && Object.keys(src).length > 0) {
		return { ts: evt.timestamp, ...src };
	}
	const meta = evt.$metadata ?? {};
	const rawMessage = (evt as { message?: unknown }).message;
	if (typeof rawMessage === 'string') {
		const trimmed = rawMessage.trim();
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				return JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				// not structured — fall through
			}
		}
		return { ...meta, message: rawMessage, ts: evt.timestamp };
	}
	return { ...meta, ts: evt.timestamp };
}

function formatPretty(payload: Record<string, unknown>): string {
	const ts = payload.ts;
	const iso =
		typeof ts === 'number' ? new Date(ts).toISOString() : String(ts ?? new Date().toISOString());
	const level = String(payload.level ?? 'info').padEnd(5);
	const event = String(payload.event ?? '<no-event>').padEnd(30);
	const rest: string[] = [];
	for (const [k, v] of Object.entries(payload)) {
		if (k === 'ts' || k === 'level' || k === 'event' || k === 'context') {
			continue;
		}
		const val = typeof v === 'string' ? v : JSON.stringify(v);
		rest.push(`${k}=${val}`);
	}
	const ctx = payload.context ? ` [${String(payload.context)}]` : '';
	return `${iso}  ${level}  ${event}${ctx}  ${rest.join(' ')}`.trimEnd();
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const body = buildQueryBody(args);
	if (args.dryRun) {
		process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
		process.exit(0);
	}
	const { accountId, token } = loadCredentials();
	const events = await runQuery(accountId, token, body);
	if (events.length === 0) {
		process.stderr.write('(no matching log lines)\n');
		process.exit(0);
	}
	// Reverse so the oldest line prints first (API returns desc).
	for (const evt of events.slice().toReversed()) {
		const payload = extractPayload(evt);
		if (args.format === 'pretty') {
			process.stdout.write(`${formatPretty(payload)}\n`);
		} else {
			process.stdout.write(`${JSON.stringify(payload)}\n`);
		}
	}
}

void main();
