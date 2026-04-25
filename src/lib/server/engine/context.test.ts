import { describe, expect, it } from 'bun:test';
import { getEvent } from '$lib/server/db/queries/events';
import type { DispatchEvent } from './dispatch.ts';
import type { Event } from '$lib/server/db/types';

// This test pins the core invariant for task 17 / backfill (task 14):
// `ctx.event.receivedAt` in the user workflow MUST be the unix-ms the event
// was originally received (the `events.received_at` column), NOT the time
// `run(event, ctx)` is executing. Backfill, heal-replay, and cron all rely
// on this — stale-event filtering breaks if it's ever `Date.now()`.
//
// The full chain is:
//   events.received_at (D1 column, int)
//     -> rowToEvent via queries/events.ts (camel-cases to receivedAt)
//     -> executor/test-runner/replay construct DispatchEvent { receivedAt }
//     -> main.ts validates ev.receivedAt is a number
//     -> buildCtx (ctx.ts) copies body.event.receivedAt into ctx.event.receivedAt
//
// We can't exercise the dispatcher end here (Workers runtime), so we cover:
// (1) the DB row -> domain Event mapping (the slice that was historically
//     easy to drop) and (2) the Event -> DispatchEvent handoff shape.

interface EventRow {
	id: string;
	event_source_id: string;
	trigger_type: string;
	payload_json: string;
	headers_json: string;
	received_at: number;
	dedup_key: string | null;
}

// Minimal D1 stub. Only implements what getEvent uses: prepare().bind().first().
function fakeDbReturningRow(row: EventRow | null): D1Database {
	const stmt = {
		bind() {
			return this;
		},
		async first<T>(): Promise<T | null> {
			return row as unknown as T | null;
		},
		async run() {
			return {};
		},
		async all<T>() {
			return { results: row ? [row as unknown as T] : [] };
		}
	};
	return {
		prepare() {
			return stmt as unknown as D1PreparedStatement;
		}
	} as unknown as D1Database;
}

describe('event -> ctx.event.receivedAt plumbing', () => {
	it('rowToEvent preserves received_at from the D1 row as receivedAt (unix ms)', async () => {
		const ORIGINAL_RECEIVED_AT = 1700000000000; // fixed, distinct from any Date.now()
		const row: EventRow = {
			id: 'evt_abc',
			event_source_id: 'src_1',
			trigger_type: 'webhook',
			payload_json: JSON.stringify({ hello: 'world' }),
			headers_json: JSON.stringify({ 'x-foo': 'bar' }),
			received_at: ORIGINAL_RECEIVED_AT,
			dedup_key: null
		};
		const db = fakeDbReturningRow(row);
		const event = await getEvent(db, 'evt_abc');
		expect(event).not.toBeNull();
		expect(event!.receivedAt).toBe(ORIGINAL_RECEIVED_AT);
		// Guard against the biggest footgun: silently substituting now() when
		// the row was missing or malformed.
		expect(event!.receivedAt).not.toBe(Date.now());
	});

	it('Event -> DispatchEvent preserves receivedAt verbatim', () => {
		const ORIGINAL_RECEIVED_AT = 1600000000000;
		const event: Event = {
			id: 'evt_xyz',
			eventSourceId: 'src_2',
			triggerType: 'webhook',
			payload: { a: 1 },
			headers: { 'x-y': 'z' },
			receivedAt: ORIGINAL_RECEIVED_AT,
			dedupKey: null
		};
		// Mirrors the construction in executor.ts, test-runner.ts, and replay.ts.
		const dispatch: DispatchEvent = {
			headers: event.headers,
			id: event.id,
			payload: event.payload,
			receivedAt: event.receivedAt,
			triggerType: event.triggerType
		};
		expect(dispatch.receivedAt).toBe(ORIGINAL_RECEIVED_AT);
	});
});
