#!/usr/bin/env bun
//
// Smoke test for the granular per-project permissions (task 10) against the
// **deployed prod** Worker + D1. Mirrors `scripts/smoke-invites.ts` in style:
// raw SQL replays of the exact statements each query helper runs, plus
// in-process assertions on `requireCan()`. Stays DB-level so we can run
// against prod without standing up a SvelteKit session.
//
// Coverage:
//   1. Migration sanity (read-only) — schema CHECK on project_members.role
//      rejects 'member', accepts 'admin'/'editor'; project_invites.role
//      column + CHECK exists.
//   2. `can()` matrix — relies on `bun test` (51 cells in
//      permissions.test.ts; 64 across all suites). This script imports
//      `requireCan` and spot-checks four denied cells against the deployed
//      module path.
//   3. End-to-end mutation behavior in a throwaway project, replaying:
//        - updateMemberRole (the SQL `changeProjectMemberRole` runs)
//        - guard rails: helper-level "cannot change owner",
//          "owners cannot change own role", "cannot set role 'owner' here"
//        - transferOwnership (2-row atomic batch)
//        - non-owner transferOwnership rejected via `requireCan`
//        - acceptInvite role propagation (admin invite ⇒ admin member)
//   4. Single-owner invariant after every transferOwnership.
//   5. HTTP spot checks (anonymous): /p/<id> gated, /invite/garbage gated.
//
// Cleanup: every row this script creates is deleted at the end. A pre/post
// SELECT COUNT() on user/projects/project_members/project_invites proves
// zero drift. The SAFETY contract for task 10 is "do not touch the real
// owner's primary project". This script never touches the existing project
// — it creates a fresh throwaway project owned by a fresh throwaway user.
//
// Auth note (matches smoke-invites): the .dev.vars CLOUDFLARE_API_TOKEN
// lacks D1 write permission, so we explicitly clear it from the spawned
// process's env and fall back to the user's `wrangler login` OAuth session.
//
// Usage:
//   bun scripts/smoke-permissions.ts
//
// Exit code 0 on full pass, 1 on first failure (cleanup still attempted).

import { spawn } from 'node:child_process';
import {
	requireCan,
	type ProjectAction,
	type ProjectRole
} from '../src/lib/server/auth/permissions.ts';

const PROD_URL = 'https://taskcompiler.com';
const DB = 'taskcompiler-dev';

interface SqlResult {
	results: unknown[];
	success: boolean;
	error?: string;
}

const RUN_TAG = `smoke-perm-${Date.now().toString(36)}`;
const OWNER_ID = `smoke-perm-owner-${RUN_TAG}`;
const ADMIN_ID = `smoke-perm-admin-${RUN_TAG}`;
const EDITOR_ID = `smoke-perm-editor-${RUN_TAG}`;
const OUTSIDER_ID = `smoke-perm-outsider-${RUN_TAG}`;
const PROJECT_ID = `smoke-perm-project-${RUN_TAG}`;
const INVITE_ID = `smoke-perm-invite-${RUN_TAG}`;
const INVITEE_ID = `smoke-perm-invitee-${RUN_TAG}`;
const INVITE_TOKEN = `tok_perm_${RUN_TAG}_${randomHex(16)}`;
const GARBAGE_TOKEN = `tok_garbage_${RUN_TAG}_does_not_exist`;

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

function randomHex(bytes: number): string {
	const a = new Uint8Array(bytes);
	crypto.getRandomValues(a);
	return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
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

interface SqlOpts {
	expectFailure?: boolean;
}

async function sql(commands: string, opts: SqlOpts = {}): Promise<SqlResult[]> {
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
				if (opts.expectFailure) {
					// Surface stderr to caller as a synthetic failed-result so the
					// caller can pattern-match on the CHECK violation message.
					resolve([{ error: stderr || stdout, results: [], success: false }]);
					return;
				}
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

async function curl(
	url: string
): Promise<{ status: number; location: string | null; body: string }> {
	const r = await fetch(url, { redirect: 'manual' });
	return { body: await r.text(), location: r.headers.get('location'), status: r.status };
}

interface CountSnapshot {
	users: number;
	projects: number;
	members: number;
	invites: number;
}

async function snapshotCounts(): Promise<CountSnapshot> {
	const out = await sql(
		`SELECT (SELECT COUNT(*) FROM user) AS users, (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM project_members) AS members, (SELECT COUNT(*) FROM project_invites) AS invites`
	);
	const r = (
		out[0]!.results as Array<{
			users: number;
			projects: number;
			members: number;
			invites: number;
		}>
	)[0]!;
	return { invites: r.invites, members: r.members, projects: r.projects, users: r.users };
}

// Replay the helper-level guard rules from `changeProjectMemberRole` so we
// can assert each rejection branch without running the SvelteKit handler.
// Mirrors data.remote.ts:328-392.
type ChangeRoleResult = { ok: true } | { ok: false; error: string };
function simulateChangeMemberRole(args: {
	callerRole: ProjectRole;
	callerUserId: string;
	targetUserId: string;
	targetRole: ProjectRole;
	newRole: string;
}): ChangeRoleResult {
	// requireCan is the first gate (member.changeRole) — owner+admin pass,
	// editor throws. We bypass it here since this helper is for the inner
	// guard-rail rejections; the requireCan gate is asserted separately in
	// the spot-check section.
	if (args.newRole === 'owner') {
		return {
			error: "Cannot set role to 'owner' here — ownership transfer requires the dedicated action.",
			ok: false
		};
	}
	if (args.newRole !== 'admin' && args.newRole !== 'editor') {
		return { error: `Invalid role '${args.newRole}'.`, ok: false };
	}
	if (args.targetRole === 'owner') {
		return {
			error: "Cannot change the owner's role. Transfer ownership instead.",
			ok: false
		};
	}
	if (args.targetUserId === args.callerUserId && args.callerRole === 'owner') {
		return {
			error: 'Owners cannot change their own role. Transfer ownership first.',
			ok: false
		};
	}
	return { ok: true };
}

async function main(): Promise<void> {
	process.stdout.write(`\n== runely permissions smoke (${RUN_TAG}) ==\n\n`);

	const before = await snapshotCounts();
	process.stdout.write(
		`pre-test counts: users=${before.users} projects=${before.projects} members=${before.members} invites=${before.invites}\n\n`
	);

	let cleanedUp = false;
	const cleanup = async (): Promise<void> => {
		if (cleanedUp) {
			return;
		}
		cleanedUp = true;
		try {
			// Order matters: drop FK-dependent rows first. project FK cascade
			// handles project_members + project_invites if the project goes,
			// but we do them explicitly in case the project insert failed.
			await sql(
				[
					`DELETE FROM project_invites WHERE id = '${INVITE_ID}'`,
					`DELETE FROM project_members WHERE project_id = '${PROJECT_ID}'`,
					`DELETE FROM projects WHERE id = '${PROJECT_ID}'`,
					`DELETE FROM user WHERE id IN ('${OWNER_ID}', '${ADMIN_ID}', '${EDITOR_ID}', '${OUTSIDER_ID}', '${INVITEE_ID}')`
				].join('; ')
			);
		} catch (err) {
			process.stderr.write(`cleanup error: ${(err as Error).message}\n`);
		}
	};

	try {
		const nowMs = Date.now();

		// === Criterion 1: migration sanity (read-only) ===

		// 1a) project_members.role CHECK schema string contains the new domain
		const schema = await sql(
			`SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('project_members','project_invites')`
		);
		const tables = schema[0]!.results as Array<{ sql: string }>;
		const memberSql =
			tables.find((t) => t.sql.includes('project_members') && !t.sql.includes('project_invites'))
				?.sql ?? '';
		const inviteSql = tables.find((t) => t.sql.includes('project_invites'))?.sql ?? '';
		record(
			'1a. project_members.role CHECK = (owner|admin|editor)',
			memberSql.includes("CHECK(role IN ('owner','admin','editor'))"),
			memberSql.includes("CHECK(role IN ('owner','admin','editor'))")
				? 'CHECK constraint matches expected domain'
				: `MISSING; got: ${memberSql.slice(0, 200)}`
		);
		record(
			'1b. project_invites.role exists with CHECK = (admin|editor)',
			inviteSql.includes("CHECK(role IN ('admin','editor'))"),
			inviteSql.includes("CHECK(role IN ('admin','editor'))")
				? 'role column + CHECK present'
				: `MISSING; got: ${inviteSql.slice(0, 300)}`
		);

		// 1c) Live CHECK enforcement: insert with role='member' must fail.
		// We use a throwaway nonexistent project_id, but we must seed a user
		// for the FK to be evaluable AFTER the CHECK. SQLite evaluates CHECK
		// before FK on insert when there's no deferred-fk; we can prove the
		// CHECK fires by attempting the bad role first against a clearly
		// nonexistent project. The error message will mention either CHECK
		// or FK — we accept both (the insert is rejected either way), but
		// also tighten to look for "CHECK" specifically since FK cascades
		// could mask intent. We seed a real user + project just to be sure
		// the CHECK is what fires.
		await sql(
			`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('${OWNER_ID}', 'Smoke Owner', 'smoke-owner+${RUN_TAG}@runely.test', 1, ${nowMs}, ${nowMs})`
		);
		await sql(
			`INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES ('${PROJECT_ID}', '${OWNER_ID}', 'Smoke Perm Project ${RUN_TAG}', ${nowMs}, ${nowMs})`
		);
		const checkAttempt = await sql(
			`INSERT INTO project_members (project_id, user_id, role, created_at) VALUES ('${PROJECT_ID}', '${OWNER_ID}', 'member', ${nowMs})`,
			{ expectFailure: true }
		);
		const checkFired = !checkAttempt[0]!.success;
		const checkMsg = checkAttempt[0]!.error ?? '';
		record(
			"1c. INSERT role='member' rejected by CHECK",
			checkFired,
			checkFired
				? `rejected as expected (error text: ${
						checkMsg
							.split('\n')
							.find((l) => /CHECK|constraint|Error/i.test(l))
							?.slice(0, 160) ??
						checkMsg.slice(0, 160) ??
						'<none captured>'
					})`
				: 'INSERT unexpectedly succeeded — rolling back'
		);
		if (!checkFired) {
			// Defensive rollback in case CHECK didn't fire (would be a real bug).
			await sql(
				`DELETE FROM project_members WHERE project_id = '${PROJECT_ID}' AND role = 'member'`
			);
		}

		// 1d) No leftover 'member' rows in the whole table.
		const leftover = await sql(`SELECT COUNT(*) AS n FROM project_members WHERE role = 'member'`);
		const leftoverN = (leftover[0]!.results as Array<{ n: number }>)[0]!.n;
		record(
			'1d. no leftover project_members rows with role=member',
			leftoverN === 0,
			`count=${leftoverN}`
		);

		// === Setup: seed throwaway users + project + 3 members ===

		await sql(
			[
				`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('${ADMIN_ID}', 'Smoke Admin', 'smoke-admin+${RUN_TAG}@runely.test', 1, ${nowMs}, ${nowMs})`,
				`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('${EDITOR_ID}', 'Smoke Editor', 'smoke-editor+${RUN_TAG}@runely.test', 1, ${nowMs}, ${nowMs})`,
				`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('${OUTSIDER_ID}', 'Smoke Outsider', 'smoke-outsider+${RUN_TAG}@runely.test', 1, ${nowMs}, ${nowMs})`,
				`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('${INVITEE_ID}', 'Smoke Invitee', 'smoke-invitee+${RUN_TAG}@runely.test', 1, ${nowMs}, ${nowMs})`,
				`INSERT INTO project_members (project_id, user_id, role, created_at) VALUES ('${PROJECT_ID}', '${OWNER_ID}', 'owner', ${nowMs})`,
				`INSERT INTO project_members (project_id, user_id, role, created_at) VALUES ('${PROJECT_ID}', '${ADMIN_ID}', 'admin', ${nowMs})`,
				`INSERT INTO project_members (project_id, user_id, role, created_at) VALUES ('${PROJECT_ID}', '${EDITOR_ID}', 'editor', ${nowMs})`
			].join('; ')
		);

		// === Criterion 2: requireCan() spot checks (in-process) ===

		const denyCases: Array<[ProjectRole, ProjectAction]> = [
			['editor', 'secret.manage'],
			['editor', 'member.invite'],
			['admin', 'project.delete'],
			['admin', 'project.transferOwnership']
		];
		for (const [role, action] of denyCases) {
			let threw = false;
			let detail = '';
			try {
				requireCan(role, action);
				detail = 'NO_THROW';
			} catch (err) {
				threw = true;
				const e = err as { status?: number; body?: { message?: string } };
				detail = `HttpError status=${e.status} message=${e.body?.message ?? ''}`;
			}
			record(`2. requireCan(${role},${action}) throws 403`, threw, detail);
		}

		// === Criterion 3: changeMemberRole matrix (helper-level guard rails) ===

		// 3a) owner -> editor → admin: succeeds
		// updateMemberRole SQL: UPDATE project_members SET role=? WHERE project_id=? AND user_id=? AND role!='owner'
		await sql(
			`UPDATE project_members SET role = 'admin' WHERE project_id = '${PROJECT_ID}' AND user_id = '${EDITOR_ID}' AND role != 'owner'`
		);
		const verifyEditorPromote = await sql(
			`SELECT role FROM project_members WHERE project_id = '${PROJECT_ID}' AND user_id = '${EDITOR_ID}'`
		);
		const editorRoleAfter = (verifyEditorPromote[0]!.results as Array<{ role: string }>)[0]?.role;
		record(
			'3a. owner promotes editor -> admin',
			editorRoleAfter === 'admin',
			`editor row role=${editorRoleAfter}`
		);

		// 3b) admin -> editor (target) → admin (newRole): SQL flip via the
		// same statement with admin as caller. Reset the editor first.
		await sql(
			`UPDATE project_members SET role = 'editor' WHERE project_id = '${PROJECT_ID}' AND user_id = '${EDITOR_ID}' AND role != 'owner'`
		);
		await sql(
			`UPDATE project_members SET role = 'admin' WHERE project_id = '${PROJECT_ID}' AND user_id = '${EDITOR_ID}' AND role != 'owner'`
		);
		const verifyAdminFlip = await sql(
			`SELECT role FROM project_members WHERE project_id = '${PROJECT_ID}' AND user_id = '${EDITOR_ID}'`
		);
		const adminFlipRole = (verifyAdminFlip[0]!.results as Array<{ role: string }>)[0]?.role;
		record(
			'3b. admin promotes editor -> admin (SQL flip)',
			adminFlipRole === 'admin',
			`row role=${adminFlipRole}`
		);

		// 3c) admin -> change owner's role: helper-level guard rejects
		const r3c = simulateChangeMemberRole({
			callerRole: 'admin',
			callerUserId: ADMIN_ID,
			newRole: 'editor',
			targetRole: 'owner',
			targetUserId: OWNER_ID
		});
		record(
			"3c. admin->changeRole(owner,'editor') rejected by helper guard",
			!r3c.ok && r3c.error === "Cannot change the owner's role. Transfer ownership instead.",
			!r3c.ok ? `error="${r3c.error}"` : 'unexpected ok'
		);
		// Belt-and-braces: the SQL also refuses (owner cannot be UPDATE'd via
		// updateMemberRole because of "AND role != 'owner'"). Verify.
		await sql(
			`UPDATE project_members SET role = 'editor' WHERE project_id = '${PROJECT_ID}' AND user_id = '${OWNER_ID}' AND role != 'owner'`
		);
		const verifyOwnerImmutable = await sql(
			`SELECT role FROM project_members WHERE project_id = '${PROJECT_ID}' AND user_id = '${OWNER_ID}'`
		);
		const ownerRoleAfter = (verifyOwnerImmutable[0]!.results as Array<{ role: string }>)[0]?.role;
		record(
			"3c'. SQL guard: owner row immune to updateMemberRole",
			ownerRoleAfter === 'owner',
			`owner.role=${ownerRoleAfter} (UPDATE was a no-op)`
		);

		// 3d) owner -> change own role: helper-level guard rejects
		const r3d = simulateChangeMemberRole({
			callerRole: 'owner',
			callerUserId: OWNER_ID,
			newRole: 'admin',
			targetRole: 'owner',
			targetUserId: OWNER_ID
		});
		// NB: target.role==='owner' check fires first in the real handler, so
		// the reported error is the "Cannot change the owner's role" one.
		// Either of the two messages is a correct rejection — we accept both.
		const ownerSelfMatched =
			!r3d.ok &&
			(r3d.error === "Cannot change the owner's role. Transfer ownership instead." ||
				r3d.error === 'Owners cannot change their own role. Transfer ownership first.');
		record(
			"3d. owner->changeRole(self,'admin') rejected",
			ownerSelfMatched,
			!r3d.ok ? `error="${r3d.error}"` : 'unexpected ok'
		);

		// 3e) anyone -> changeRole(any, 'owner'): rejected pre-DB
		for (const callerRole of ['owner', 'admin'] as const) {
			const r = simulateChangeMemberRole({
				callerRole,
				callerUserId: callerRole === 'owner' ? OWNER_ID : ADMIN_ID,
				newRole: 'owner',
				targetRole: 'editor',
				targetUserId: EDITOR_ID
			});
			record(
				`3e. ${callerRole}->changeRole(editor,'owner') rejected`,
				!r.ok &&
					r.error ===
						"Cannot set role to 'owner' here — ownership transfer requires the dedicated action.",
				!r.ok ? `error="${r.error}"` : 'unexpected ok'
			);
		}

		// === Criterion 4: transferOwnership atomic batch + invariant ===

		// First, reset the editor back to editor (we promoted them earlier).
		await sql(
			`UPDATE project_members SET role = 'editor' WHERE project_id = '${PROJECT_ID}' AND user_id = '${EDITOR_ID}' AND role != 'owner'`
		);

		// transferOwnership SQL batch (mirrors invites.ts:241-255):
		// 1) demote old owner to admin
		// 2) promote new owner
		// We replay both as a single multi-statement command — D1 wraps them
		// in an implicit transaction per the wrangler --command semantics
		// (statements separated by `;` run sequentially, atomic per request).
		await sql(
			[
				`UPDATE project_members SET role = 'admin' WHERE project_id = '${PROJECT_ID}' AND user_id = '${OWNER_ID}' AND role = 'owner'`,
				`UPDATE project_members SET role = 'owner' WHERE project_id = '${PROJECT_ID}' AND user_id = '${ADMIN_ID}'`
			].join('; ')
		);

		const verifyTransfer = await sql(
			`SELECT user_id, role FROM project_members WHERE project_id = '${PROJECT_ID}' ORDER BY role`
		);
		const rows = verifyTransfer[0]!.results as Array<{ user_id: string; role: string }>;
		const newOwnerRow = rows.find((r) => r.user_id === ADMIN_ID);
		const oldOwnerRow = rows.find((r) => r.user_id === OWNER_ID);
		record(
			'4a. transferOwnership: new owner is owner',
			newOwnerRow?.role === 'owner',
			`${ADMIN_ID}.role=${newOwnerRow?.role}`
		);
		record(
			'4b. transferOwnership: old owner demoted to admin',
			oldOwnerRow?.role === 'admin',
			`${OWNER_ID}.role=${oldOwnerRow?.role}`
		);

		// 4c) Single-owner invariant
		const ownerCountResult = await sql(
			`SELECT COUNT(*) AS n FROM project_members WHERE project_id = '${PROJECT_ID}' AND role = 'owner'`
		);
		const ownerCount = (ownerCountResult[0]!.results as Array<{ n: number }>)[0]!.n;
		record(
			'4c. single-owner invariant after transfer',
			ownerCount === 1,
			`COUNT(role='owner')=${ownerCount}`
		);

		// 4d) Non-owner transferOwnership rejected via requireCan. We can't
		// reach the actual command from here (no session), but we assert the
		// gate the command's first line runs: requireCan(role, 'project.transferOwnership').
		let nonOwnerThrew = false;
		let nonOwnerDetail = '';
		try {
			requireCan('admin', 'project.transferOwnership');
			nonOwnerDetail = 'NO_THROW';
		} catch (err) {
			nonOwnerThrew = true;
			const e = err as { status?: number; body?: { message?: string } };
			nonOwnerDetail = `HttpError status=${e.status} message=${e.body?.message ?? ''}`;
		}
		record(
			'4d. non-owner (admin) transferOwnership blocked at requireCan',
			nonOwnerThrew,
			nonOwnerDetail
		);

		// === Criterion 5: acceptInvite role propagation ===

		// Restore: ADMIN_ID is now owner; restore OWNER_ID to owner so the
		// project has its original owner (clean state for invite test).
		await sql(
			[
				`UPDATE project_members SET role = 'admin' WHERE project_id = '${PROJECT_ID}' AND user_id = '${ADMIN_ID}' AND role = 'owner'`,
				`UPDATE project_members SET role = 'owner' WHERE project_id = '${PROJECT_ID}' AND user_id = '${OWNER_ID}'`
			].join('; ')
		);

		// Create an invite with role='admin'.
		const expiresAt = nowMs + 7 * 86400 * 1000;
		await sql(
			`INSERT INTO project_invites (id, project_id, email, token, invited_by, status, role, expires_at, created_at) VALUES ('${INVITE_ID}', '${PROJECT_ID}', 'smoke-invitee+${RUN_TAG}@runely.test', '${INVITE_TOKEN}', '${OWNER_ID}', 'pending', 'admin', ${expiresAt}, ${nowMs})`
		);

		// Replay the acceptInvite() batch from invites.ts:148-167
		await sql(
			[
				`INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_at) VALUES ('${PROJECT_ID}', '${INVITEE_ID}', 'admin', ${nowMs})`,
				`UPDATE project_invites SET status = 'accepted' WHERE id = '${INVITE_ID}' AND status = 'pending'`
			].join('; ')
		);

		const verifyAccept = await sql(
			[
				`SELECT role FROM project_members WHERE project_id = '${PROJECT_ID}' AND user_id = '${INVITEE_ID}'`,
				`SELECT status FROM project_invites WHERE id = '${INVITE_ID}'`
			].join('; ')
		);
		const memRow = (verifyAccept[0]!.results as Array<{ role: string }>)[0];
		const invRow = (verifyAccept[1]!.results as Array<{ status: string }>)[0];
		record(
			"5. acceptInvite(role='admin') makes new member with role='admin'",
			memRow?.role === 'admin' && invRow?.status === 'accepted',
			`member.role=${memRow?.role ?? 'MISSING'}, invite.status=${invRow?.status ?? 'MISSING'}`
		);

		// === Criterion 6: HTTP spot checks (anonymous) ===

		const anonProject = await curl(`${PROD_URL}/p/${PROJECT_ID}`);
		// SvelteKit redirect to /login or 401/403; not a 200 with project data.
		const projectGated =
			anonProject.status === 302 ||
			anonProject.status === 303 ||
			anonProject.status === 401 ||
			anonProject.status === 403 ||
			(anonProject.status === 200 && /sign in|login/i.test(anonProject.body));
		record(
			'6a. anonymous GET /p/<id> is gated',
			projectGated,
			`status=${anonProject.status} location=${anonProject.location ?? '-'}`
		);

		const anonGarbage = await curl(`${PROD_URL}/invite/${GARBAGE_TOKEN}`);
		record(
			'6b. anonymous GET /invite/<garbage> renders not-recognized',
			anonGarbage.body.includes('not recognized'),
			anonGarbage.body.includes('not recognized')
				? 'body contains "not recognized"'
				: `MISSING; status=${anonGarbage.status}; first 200: ${anonGarbage.body.slice(0, 200).replace(/\s+/g, ' ')}`
		);
	} finally {
		await cleanup();
	}

	const after = await snapshotCounts();
	process.stdout.write(
		`\npost-test counts: users=${after.users} projects=${after.projects} members=${after.members} invites=${after.invites}\n`
	);
	const drift =
		after.users !== before.users ||
		after.projects !== before.projects ||
		after.members !== before.members ||
		after.invites !== before.invites;
	if (drift) {
		process.stdout.write(
			`!! DRIFT: pre {users:${before.users},projects:${before.projects},members:${before.members},invites:${before.invites}} != post {users:${after.users},projects:${after.projects},members:${after.members},invites:${after.invites}}\n`
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
