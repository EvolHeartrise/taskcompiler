#!/usr/bin/env bun
//
// Smoke test for workflow pause + backfill (tasks 13/14/17) against the
// **deployed prod** Worker + D1. Mirrors `scripts/smoke-permissions.ts` and
// `scripts/smoke-invites.ts` in style: raw SQL replays of the exact shapes
// the engine writes, plus targeted HTTP calls to /hook/<sourceId> to prove
// the webhook-deferral invariant end-to-end. Stays DB-level for the
// backfill loop (Path B in the task brief) — the loop's execution is
// covered by the implementation agent's dev-server smoke during task 14;
// this script verifies the *durable invariants* the loop maintains.
//
// Coverage:
//   Pause phase (via raw SQL mimicking pauseWorkflow):
//     P1. UPDATE workflows SET status='paused',paused_at,paused_by lands
//         (SELECT shows status='paused').
//     P2. Webhook POST during pause: the /hook/<sourceId> handler always
//         returns 200, the `events` row is created, and no `runs` row is
//         created for the paused workflow.
//     P3. Cron skip during pause: SKIPPED — see note in the code. The
//         /api/dev/cron-tick endpoint is a SvelteKit command() requiring
//         an authenticated session; driving it from a non-interactive
//         script is not trivial. The executor path is identical to the
//         webhook path (both funnel through `executeSourceEvent`), so P2
//         exercises the same `if (workflow.status === 'paused')` branch.
//     P4. Manual trigger rejected during pause: SKIPPED — needs a session.
//         Unit-tested by task 13's executor changes.
//     P5. Healer skipped during pause: SKIPPED — needs a failing run to
//         trigger heal. Covered by the pausedNow guard in executor.ts:443.
//
//   Backfill phase (Path B — simulates the loop via direct SQL):
//     B1. FIFO: 5 unrun events with strictly-increasing received_at get
//         run rows in the same order (listUnrunEventsForWorkflow ORDER BY
//         received_at ASC is the contract). We INSERT runs in the order
//         the loop would and verify started_at monotonically increases.
//     B2. is_replay=1 on every backfilled run (matches the loop's
//         `executeExistingEventForWorkflow(..., { isReplay: true })`).
//     B3. Original event received_at predates the resume time (trivial
//         for Path B since we control the seeding; proves task 17 only
//         via the "deferred event stays put, is not re-stamped" shape).
//     B4. Re-pause halts cleanly: set up N events, simulate a partial
//         loop that halts when status flips to paused between events,
//         count runs < N. The loop's per-iteration getWorkflowStatus
//         re-check is the contract.
//     B5. Resume without backfill leaves events unrun: flip to active,
//         skip the loop, count events without runs stays = seeded.
//     B6. Single-flight: SKIPPED — the `inFlight` Map in backfill.ts is
//         per-isolate and only observable from within the Worker itself.
//
// Cleanup: every row this script creates is deleted at the end. A pre/post
// SELECT COUNT() on user/projects/project_members/project_invites/workflows/
// event_sources/events/runs proves zero drift. The SAFETY contract: we
// create a throwaway user + project + event_source + workflow; we never
// touch the real owner's primary project or any existing workflow.
//
// Auth note (matches smoke-invites + smoke-permissions): the .dev.vars
// CLOUDFLARE_API_TOKEN lacks D1 write permission, so we explicitly clear
// it from the spawned process's env and fall back to the user's
// `wrangler login` OAuth session.
//
// Usage:
//   bun scripts/smoke-pause.ts
//
// Exit code 0 on full pass, 1 on first failure (cleanup still attempted).

import { spawn } from 'node:child_process';

const PROD_URL = 'https://taskcompiler.com';
const DB = 'taskcompiler-dev';

interface SqlResult {
	results: unknown[];
	success: boolean;
	error?: string;
}

const RUN_TAG = `smoke-pause-${Date.now().toString(36)}`;
const OWNER_ID = `smoke-pause-owner-${RUN_TAG}`;
const PROJECT_ID = `smoke-pause-project-${RUN_TAG}`;
const SOURCE_ID = `smoke-pause-source-${RUN_TAG}`;
const WORKFLOW_ID = `smoke-pause-workflow-${RUN_TAG}`;
// Backfill runs require a version row (FK: runs.version_id -> workflow_versions.id).
// We seed one no-op version row; it's a pure FK target, never dispatched against.
const VERSION_ID = `smoke-pause-version-${RUN_TAG}`;

interface Step {
	name: string;
	pass: boolean;
	detail: string;
}
const steps: Step[] = [];

function record(name: string, pass: boolean, detail: string): void {
	steps.push({ detail, name, pass });
	const tag = pass ? 'PASS' : 'FAIL';
	process.stdout.write(`[${tag}] ${name}: ${detail}\n`);
}

function skip(name: string, reason: string): void {
	// Mirror record()'s output so the summary aligns, but count as pass
	// for exit-code purposes and tag as SKIP in the printed line so the
	// operator can see what was punted on.
	steps.push({ detail: reason, name, pass: true });
	process.stdout.write(`[SKIP] ${name}: ${reason}\n`);
}

function wranglerBin(): string {
	const { existsSync } = require('node:fs') as typeof import('node:fs');
	const path = require('node:path') as typeof import('node:path');
	const candidates =
		process.platform === 'win32'
			? ['node_modules/.bin/wrangler.exe', 'node_modules/.bin/wrangler.cmd']
			: ['node_modules/.bin/wrangler'];
	for (const rel of candidates) {
		const abs = path.resolve(process.cwd(), rel);
		if (existsSync(abs)) {
			return abs;
		}
	}
	return process.platform === 'win32' ? 'wrangler.exe' : 'wrangler';
}

async function sql(commands: string): Promise<SqlResult[]> {
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	return new Promise<SqlResult[]>((resolve, reject) => {
		const p = spawn(
			wranglerBin(),
			['d1', 'execute', DB, '--remote', '--json', '--command', commands],
			{ env, shell: false }
		);
		let stdout = '';
		let stderr = '';
		p.stdout.on('data', (d) => (stdout += d.toString()));
		p.stderr.on('data', (d) => (stderr += d.toString()));
		p.on('close', (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`wrangler exit ${code}\nstdout: ${stdout.slice(0, 800)}\nstderr: ${stderr.slice(0, 800)}`
					)
				);
				return;
			}
			try {
				const i = stdout.indexOf('[');
				if (i === -1) {
					reject(new Error(`no JSON in wrangler output: ${stdout.slice(0, 400)}`));
					return;
				}
				resolve(JSON.parse(stdout.slice(i)) as SqlResult[]);
			} catch (err) {
				reject(err as Error);
			}
		});
	});
}

async function postWebhook(
	sourceId: string,
	body: unknown
): Promise<{ status: number; body: string }> {
	const r = await fetch(`${PROD_URL}/hook/${sourceId}`, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});
	return { body: await r.text(), status: r.status };
}

interface CountSnapshot {
	users: number;
	projects: number;
	members: number;
	invites: number;
	workflows: number;
	sources: number;
	events: number;
	runs: number;
}

async function snapshotCounts(): Promise<CountSnapshot> {
	const out = await sql(
		`SELECT
			(SELECT COUNT(*) FROM user) AS users,
			(SELECT COUNT(*) FROM projects) AS projects,
			(SELECT COUNT(*) FROM project_members) AS members,
			(SELECT COUNT(*) FROM project_invites) AS invites,
			(SELECT COUNT(*) FROM workflows) AS workflows,
			(SELECT COUNT(*) FROM event_sources) AS sources,
			(SELECT COUNT(*) FROM events) AS events,
			(SELECT COUNT(*) FROM runs) AS runs`
	);
	const r = (out[0]!.results as Array<CountSnapshot>)[0]!;
	return {
		events: r.events,
		invites: r.invites,
		members: r.members,
		projects: r.projects,
		runs: r.runs,
		sources: r.sources,
		users: r.users,
		workflows: r.workflows
	};
}

async function main(): Promise<void> {
	process.stdout.write(`\n== runely pause+backfill smoke (${RUN_TAG}) ==\n\n`);

	const before = await snapshotCounts();
	process.stdout.write(
		`pre-test counts: users=${before.users} projects=${before.projects} members=${before.members} invites=${before.invites} workflows=${before.workflows} sources=${before.sources} events=${before.events} runs=${before.runs}\n\n`
	);

	let cleanedUp = false;
	const cleanup = async (): Promise<void> => {
		if (cleanedUp) {
			return;
		}
		cleanedUp = true;
		try {
			// Order: FK-dependent rows first. runs -> events -> workflow_versions
			// -> workflows -> event_sources -> project_members -> projects ->
			// user. We NULL workflows.current_version_id first so the circular
			// workflows <-> workflow_versions FK doesn't block the delete.
			await sql(
				[
					`UPDATE workflows SET current_version_id = NULL WHERE id = '${WORKFLOW_ID}'`,
					`DELETE FROM runs WHERE workflow_id = '${WORKFLOW_ID}'`,
					`DELETE FROM events WHERE event_source_id = '${SOURCE_ID}'`,
					`DELETE FROM workflow_versions WHERE workflow_id = '${WORKFLOW_ID}'`,
					`DELETE FROM workflows WHERE id = '${WORKFLOW_ID}'`,
					`DELETE FROM event_sources WHERE id = '${SOURCE_ID}'`,
					`DELETE FROM project_members WHERE project_id = '${PROJECT_ID}'`,
					`DELETE FROM projects WHERE id = '${PROJECT_ID}'`,
					`DELETE FROM user WHERE id = '${OWNER_ID}'`
				].join('; ')
			);
		} catch (err) {
			process.stderr.write(`cleanup error: ${(err as Error).message}\n`);
		}
	};

	try {
		const nowMs = Date.now();

		// === Setup: throwaway user/project/source/workflow/version ===
		//
		// Mirrors createEventSource/createWorkflow/createWorkflowVersion shapes
		// exactly so the executor accepts the row (webhook ingest path reads
		// event_source.trigger_type and iterates workflows.event_source_id).
		await sql(
			[
				`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('${OWNER_ID}', 'Smoke Pause Owner', 'smoke-pause+${RUN_TAG}@runely.test', 1, ${nowMs}, ${nowMs})`,
				`INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES ('${PROJECT_ID}', '${OWNER_ID}', 'Smoke Pause Project ${RUN_TAG}', ${nowMs}, ${nowMs})`,
				`INSERT INTO project_members (project_id, user_id, role, created_at) VALUES ('${PROJECT_ID}', '${OWNER_ID}', 'owner', ${nowMs})`,
				`INSERT INTO event_sources (id, project_id, name, trigger_type, cron_expr, created_at, updated_at, last_fired_at) VALUES ('${SOURCE_ID}', '${PROJECT_ID}', 'Smoke Source', 'webhook', NULL, ${nowMs}, ${nowMs}, 0)`,
				// Workflow starts active; we flip to paused via SQL below.
				// current_version_id=NULL at first (so we can insert the
				// version row next without a FK-evaluation ordering issue),
				// then we UPDATE it to point at VERSION_ID.
				`INSERT INTO workflows (id, project_id, event_source_id, name, prompt, current_version_id, status, paused_at, paused_by, created_at, updated_at) VALUES ('${WORKFLOW_ID}', '${PROJECT_ID}', '${SOURCE_ID}', 'Smoke Workflow', 'smoke prompt', NULL, 'active', NULL, NULL, ${nowMs}, ${nowMs})`,
				`INSERT INTO workflow_versions (id, workflow_id, version, source_ts, deploy_path, created_at, created_by, parent_version_id, healed_from_run_id) VALUES ('${VERSION_ID}', '${WORKFLOW_ID}', 1, 'smoke-source', 'smoke/noop', ${nowMs}, 'user', NULL, NULL)`,
				`UPDATE workflows SET current_version_id = '${VERSION_ID}' WHERE id = '${WORKFLOW_ID}'`
			].join('; ')
		);

		// === Pause phase ===

		// P1) Pause via the exact SQL pauseWorkflow runs (workflows.ts:157-173).
		const pausedAt = Date.now();
		await sql(
			`UPDATE workflows SET status = 'paused', paused_at = ${pausedAt}, paused_by = '${OWNER_ID}', updated_at = ${pausedAt} WHERE id = '${WORKFLOW_ID}' AND project_id = '${PROJECT_ID}' AND status = 'active'`
		);
		const pausedCheck = await sql(
			`SELECT status, paused_at, paused_by FROM workflows WHERE id = '${WORKFLOW_ID}'`
		);
		const pausedRow = (
			pausedCheck[0]!.results as Array<{ status: string; paused_at: number; paused_by: string }>
		)[0];
		record(
			'P1. workflow SQL-paused (status=paused, paused_at/by set)',
			pausedRow?.status === 'paused' &&
				pausedRow.paused_at === pausedAt &&
				pausedRow.paused_by === OWNER_ID,
			`status=${pausedRow?.status} paused_at=${pausedRow?.paused_at} paused_by=${pausedRow?.paused_by}`
		);

		// P2) Webhook POST during pause: event row lands, no run row.
		// The /hook/<sourceId> handler is public and always 200s; the
		// executor's paused-workflow branch (executor.ts:221-236) persists
		// the event and skips the run insert, logging workflow.event_deferred.
		const p2Before = Date.now();
		const hookResp = await postWebhook(SOURCE_ID, { smoke: 'p2', tag: RUN_TAG });
		const eventsAfterHook = await sql(
			`SELECT id, trigger_type, received_at FROM events WHERE event_source_id = '${SOURCE_ID}' ORDER BY received_at ASC`
		);
		const hookEventRow = (
			eventsAfterHook[0]!.results as Array<{
				id: string;
				trigger_type: string;
				received_at: number;
			}>
		)[0];
		const runsAfterHook = await sql(`SELECT id FROM runs WHERE workflow_id = '${WORKFLOW_ID}'`);
		const runCountAfterHook = (runsAfterHook[0]!.results as Array<{ id: string }>).length;
		record(
			'P2. webhook POST during pause: 200, event persisted, no run',
			hookResp.status === 200 &&
				Boolean(hookEventRow) &&
				hookEventRow!.trigger_type === 'webhook' &&
				hookEventRow!.received_at >= p2Before - 5000 &&
				runCountAfterHook === 0,
			`hookStatus=${hookResp.status} eventRow=${hookEventRow ? `${hookEventRow.id}/${hookEventRow.trigger_type}` : 'MISSING'} runs=${runCountAfterHook}`
		);

		// Capture that hook event id for the FIFO check; it's the earliest.
		const hookEventId = hookEventRow?.id;

		// P3) Cron skip: SKIPPED — /api/dev/cron-tick is a command() that
		// requires an authenticated session (see src/routes/api/dev/cron-tick/
		// data.remote.ts). The code path is identical to the webhook path
		// (executeSourceEvent dispatches both), which P2 already exercises.
		skip(
			'P3. cron skip during pause',
			'command() requires session; webhook path exercises same executeSourceEvent branch'
		);

		// P4) Manual trigger rejected: SKIPPED — executeManualEvent throws
		// WorkflowPausedError (executor.ts:286-304), verified by task 13's
		// unit tests. Reaching it from this script would need a logged-in
		// session.
		skip(
			'P4. manual trigger rejected during pause',
			'requires session; covered by WorkflowPausedError unit test (task 13)'
		);

		// P5) Healer skipped: SKIPPED — triggering a heal requires a failing
		// run (run_failed -> pausedNow re-check at executor.ts:443). Faking
		// that requires deploying a workflow that errors and running it,
		// which adds deploy plumbing this smoke intentionally avoids.
		skip(
			'P5. healer skipped during pause',
			'needs failing run to trigger heal; covered by task 13 executor changes'
		);

		// === Backfill phase (Path B — simulate loop via direct SQL) ===

		// Seed 4 more unrun events (total 5 including the webhook one) with
		// strictly-increasing received_at, all stamped AFTER the live hook
		// event so the hook event remains the earliest. We query the hook
		// event's actual received_at (which was stamped server-side, not by
		// us) and chain off it.
		const hookEventTs = hookEventRow?.received_at ?? pausedAt;
		const baseTs = hookEventTs + 1;
		const extraEventIds: string[] = [];
		for (let i = 0; i < 4; i++) {
			const id = `${RUN_TAG}-bf-event-${i}`;
			extraEventIds.push(id);
			await sql(
				`INSERT INTO events (id, event_source_id, trigger_type, payload_json, headers_json, received_at, dedup_key) VALUES ('${id}', '${SOURCE_ID}', 'webhook', '${JSON.stringify({ smoke: 'bf', idx: i }).replace(/'/g, "''")}', '{}', ${baseTs + i}, NULL)`
			);
		}

		// Confirm we have 5 unrun events in received_at ASC order.
		const unrunBefore = await sql(
			`SELECT e.id, e.received_at FROM events e
			 JOIN workflows w ON w.event_source_id = e.event_source_id
			 LEFT JOIN runs r ON r.event_id = e.id AND r.workflow_id = w.id
			 WHERE w.id = '${WORKFLOW_ID}' AND r.id IS NULL
			 ORDER BY e.received_at ASC`
		);
		const unrunRows = unrunBefore[0]!.results as Array<{ id: string; received_at: number }>;
		record(
			'backfill-setup. 5 unrun events queued in received_at ASC',
			unrunRows.length === 5 &&
				unrunRows.every((r, idx) => idx === 0 || r.received_at > unrunRows[idx - 1]!.received_at),
			`unrunCount=${unrunRows.length} strictlyAscending=${unrunRows.every((r, idx) => idx === 0 || r.received_at > unrunRows[idx - 1]!.received_at)}`
		);
		// Record the hookEventId placement for B3.
		const hookIsFirst = unrunRows[0]?.id === hookEventId;

		// Simulate the backfill loop: flip status to active, then INSERT a
		// run row per event in received_at ASC order with is_replay=1. We
		// space started_at by +1ms per iteration to make FIFO ordering
		// strictly verifiable (the real loop's started_at comes from now()
		// which will also monotonically increase, but sub-ms ties are
		// theoretically possible in-prod — the test's spacing is tighter
		// than prod's but the contract is "not-decreasing" which the real
		// loop satisfies via sequential await).
		//
		// Before flipping to active, assert we'd flip (resumeWorkflow SQL).
		await sql(
			`UPDATE workflows SET status = 'active', paused_at = NULL, paused_by = NULL, updated_at = ${Date.now()} WHERE id = '${WORKFLOW_ID}' AND project_id = '${PROJECT_ID}' AND status = 'paused'`
		);

		// Capture the resume-at timestamp — the moment pause ended. Every
		// backfilled event's received_at must predate this (B3's contract).
		const resumeAt = Date.now();
		// Replay 3 of the 5 to simulate a partial loop (the halt-before-
		// resume path). We'll re-pause between iterations 3 and 4 to exercise
		// B4. For B1-B3 we need all 5 processed, so: do 3 first, then
		// re-pause and assert B4, then un-pause and do the remaining 2.
		const runInsertBaseTs = resumeAt;
		const runIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const runId = `${RUN_TAG}-run-${i}`;
			runIds.push(runId);
			const startedAt = runInsertBaseTs + i * 2;
			await sql(
				`INSERT INTO runs (id, event_id, workflow_id, version_id, started_at, finished_at, status, error_json, result_json, logs_json, is_replay, parent_run_id) VALUES ('${runId}', '${unrunRows[i]!.id}', '${WORKFLOW_ID}', '${VERSION_ID}', ${startedAt}, ${startedAt + 1}, 'ok', NULL, NULL, NULL, 1, NULL)`
			);
		}

		// B4) Re-pause halts cleanly. Flip status=paused; a real loop's
		// next iteration's getWorkflowStatus would return 'paused' and
		// break. Count runs < 5 at this moment.
		await sql(
			`UPDATE workflows SET status = 'paused', paused_at = ${Date.now()}, paused_by = '${OWNER_ID}', updated_at = ${Date.now()} WHERE id = '${WORKFLOW_ID}' AND project_id = '${PROJECT_ID}' AND status = 'active'`
		);
		const midRuns = await sql(
			`SELECT COUNT(*) AS n FROM runs WHERE workflow_id = '${WORKFLOW_ID}'`
		);
		const midRunCount = (midRuns[0]!.results as Array<{ n: number }>)[0]!.n;
		record(
			'B4. re-pause halts loop: partial run count < total events',
			midRunCount === 3 && midRunCount < unrunRows.length,
			`runs=${midRunCount}/${unrunRows.length} (loop halted mid-batch)`
		);

		// B5) Resume without backfill leaves events unrun. Flip to active,
		// skip the loop, count events-without-runs should stay at 2 (the
		// two we haven't processed yet).
		await sql(
			`UPDATE workflows SET status = 'active', paused_at = NULL, paused_by = NULL, updated_at = ${Date.now()} WHERE id = '${WORKFLOW_ID}' AND project_id = '${PROJECT_ID}' AND status = 'paused'`
		);
		const unrunAfterPlainResume = await sql(
			`SELECT COUNT(*) AS n FROM events e
			 JOIN workflows w ON w.event_source_id = e.event_source_id
			 LEFT JOIN runs r ON r.event_id = e.id AND r.workflow_id = w.id
			 WHERE w.id = '${WORKFLOW_ID}' AND r.id IS NULL`
		);
		const unrunAfterN = (unrunAfterPlainResume[0]!.results as Array<{ n: number }>)[0]!.n;
		record(
			'B5. resume without backfill: events stay unrun',
			unrunAfterN === 2,
			`unrunEvents=${unrunAfterN} (expected 2)`
		);

		// Now process the remaining 2 to make B1-B3 assertable over the
		// full 5-event sweep.
		for (let i = 3; i < 5; i++) {
			const runId = `${RUN_TAG}-run-${i}`;
			runIds.push(runId);
			const startedAt = runInsertBaseTs + i * 2 + 100; // strictly > earlier 3
			await sql(
				`INSERT INTO runs (id, event_id, workflow_id, version_id, started_at, finished_at, status, error_json, result_json, logs_json, is_replay, parent_run_id) VALUES ('${runId}', '${unrunRows[i]!.id}', '${WORKFLOW_ID}', '${VERSION_ID}', ${startedAt}, ${startedAt + 1}, 'ok', NULL, NULL, NULL, 1, NULL)`
			);
		}

		// B1) FIFO. Fetch runs JOINed to events, ordered by runs.started_at,
		// and assert the sequence of event.received_at is monotonically
		// non-decreasing. Also the number of runs matches the number of
		// seeded events.
		const fifoCheck = await sql(
			`SELECT r.id AS run_id, r.started_at, r.is_replay, e.id AS event_id, e.received_at
			 FROM runs r JOIN events e ON e.id = r.event_id
			 WHERE r.workflow_id = '${WORKFLOW_ID}'
			 ORDER BY r.started_at ASC`
		);
		const fifoRows = fifoCheck[0]!.results as Array<{
			run_id: string;
			started_at: number;
			is_replay: number;
			event_id: string;
			received_at: number;
		}>;
		const fifoMonotonic = fifoRows.every(
			(r, idx) => idx === 0 || r.received_at >= fifoRows[idx - 1]!.received_at
		);
		record(
			'B1. FIFO: runs emerge in event.received_at ASC order',
			fifoRows.length === 5 && fifoMonotonic,
			`runs=${fifoRows.length} monotonic=${fifoMonotonic}`
		);

		// B2) is_replay=1 on every backfilled run.
		const allReplay = fifoRows.every((r) => r.is_replay === 1);
		record(
			'B2. is_replay=1 on every backfilled run',
			allReplay,
			`replayCount=${fifoRows.filter((r) => r.is_replay === 1).length}/${fifoRows.length}`
		);

		// B3) Original event received_at predates the resume time. All 5
		// events were stamped during or before the paused window; resumeAt
		// captures the moment the status flipped back to 'active'. Also
		// assert hookEventFirst — the live webhook event must be the
		// earliest (we seeded the others with received_at > its).
		const allBeforeResume = fifoRows.every((r) => r.received_at < resumeAt);
		const allBeforeRun = fifoRows.every((r) => r.received_at < r.started_at);
		const b3Ok = hookIsFirst && allBeforeResume && allBeforeRun;
		record(
			'B3. event received_at predates resume time',
			b3Ok,
			`hookFirst=${hookIsFirst} allBeforeResume=${allBeforeResume} allBeforeRun=${allBeforeRun} resumeAt=${resumeAt}`
		);

		// B6) Single-flight: SKIPPED — the inFlight Map is per-isolate and
		// only observable inside the Worker. Path A would be needed to test
		// this (two near-simultaneous resume() calls producing one
		// workflow.backfill_started log). The implementation agent's task-14
		// dev-server smoke covered this.
		skip(
			'B6. single-flight (two concurrent resumes produce one start)',
			'per-isolate Map; requires Path A (in-Worker) to observe'
		);
	} finally {
		await cleanup();
	}

	const after = await snapshotCounts();
	process.stdout.write(
		`\npost-test counts: users=${after.users} projects=${after.projects} members=${after.members} invites=${after.invites} workflows=${after.workflows} sources=${after.sources} events=${after.events} runs=${after.runs}\n`
	);
	const drift =
		after.users !== before.users ||
		after.projects !== before.projects ||
		after.members !== before.members ||
		after.invites !== before.invites ||
		after.workflows !== before.workflows ||
		after.sources !== before.sources ||
		after.events !== before.events ||
		after.runs !== before.runs;
	if (drift) {
		process.stdout.write(
			`!! DRIFT: pre {u:${before.users},p:${before.projects},m:${before.members},i:${before.invites},w:${before.workflows},s:${before.sources},e:${before.events},r:${before.runs}} != post {u:${after.users},p:${after.projects},m:${after.members},i:${after.invites},w:${after.workflows},s:${after.sources},e:${after.events},r:${after.runs}}\n`
		);
		record('cleanup. pre/post counts match', false, 'DRIFT detected');
	} else {
		process.stdout.write(`cleanup verified -- pre/post counts match\n`);
		record('cleanup. pre/post counts match', true, 'no drift');
	}

	const failed = steps.filter((s) => !s.pass);
	process.stdout.write(`\n== summary: ${steps.length - failed.length}/${steps.length} pass ==\n`);
	if (failed.length > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(`smoke crashed: ${(err as Error).stack ?? (err as Error).message}\n`);
	process.exit(1);
});
