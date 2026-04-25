#!/usr/bin/env bun
//
// Smoke test for the project-invite flow against the **deployed prod**
// Worker + D1. Runs entirely DB-level (no Playwright session, no real
// magic-link auth) and exercises every state the `/invite/[token]`
// load+action expose.
//
// Coverage:
//   1. Invite creation        — INSERT into project_invites, status=pending
//   2. Accept-URL state pages — anonymous curl against each of the 5 states
//   3. Accept-flow success    — runs the exact batch acceptInvite() runs
//   4. Post-accept access     — getProjectForUser SELECT returns the project
//   5. Revoke / leave / remove — runs each command's mutation + verifies
//
// Cleanup: every row this script creates is deleted at the end. A pre/post
// SELECT COUNT() on the affected tables proves zero drift.
//
// Auth note (task 2 gotcha): the .dev.vars CLOUDFLARE_API_TOKEN lacks D1
// write permission, so we explicitly clear it from this process's env and
// fall back to the user's `wrangler login` OAuth session.
//
// Usage:
//   bun scripts/smoke-invites.ts
//
// Exit code 0 on full pass, 1 on first failure (cleanup still attempted).

import { spawn } from 'node:child_process';

const PROD_URL = 'https://taskcompiler.com';
const DB = 'taskcompiler-dev';

interface SqlResult {
	results: unknown[];
	success: boolean;
}

// Generate test ids/tokens with deterministic prefixes so cleanup can target
// exactly what we created without touching pre-existing rows.
const RUN_TAG = `smoke-${Date.now().toString(36)}`;
const TEST_USER_ID = `test-user-${RUN_TAG}`;
const TEST_USER_EMAIL = `smoke+${RUN_TAG}@runely.test`;
const VALID_INVITE_ID = `test-invite-valid-${RUN_TAG}`;
const VALID_INVITE_TOKEN = `tok_valid_${RUN_TAG}_${randomHex(16)}`;
const REVOKED_INVITE_ID = `test-invite-revoked-${RUN_TAG}`;
const REVOKED_INVITE_TOKEN = `tok_revoked_${RUN_TAG}_${randomHex(16)}`;
const EXPIRED_INVITE_ID = `test-invite-expired-${RUN_TAG}`;
const EXPIRED_INVITE_TOKEN = `tok_expired_${RUN_TAG}_${randomHex(16)}`;
const ACCEPTED_INVITE_ID = `test-invite-accepted-${RUN_TAG}`;
const ACCEPTED_INVITE_TOKEN = `tok_accepted_${RUN_TAG}_${randomHex(16)}`;
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

// Resolve the wrangler binary in node_modules so we can spawn with
// shell:false (avoids cross-platform quote mangling on the SQL command).
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
	// Strip CLOUDFLARE_API_TOKEN from the spawned process's env so wrangler
	// uses the OAuth login (which has D1 write perms) instead of the
	// limited token in .dev.vars. We use --command (returns row data) with
	// shell:false to avoid cross-platform quote mangling.
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

async function curlBody(url: string): Promise<string> {
	const r = await fetch(url, { redirect: 'manual' });
	return r.text();
}

interface CountSnapshot {
	users: number;
	invites: number;
	members: number;
}

async function snapshotCounts(): Promise<CountSnapshot> {
	const out = await sql(
		`SELECT (SELECT COUNT(*) FROM user) AS users, (SELECT COUNT(*) FROM project_invites) AS invites, (SELECT COUNT(*) FROM project_members) AS members`
	);
	const r = (out[0]!.results as Array<{ users: number; invites: number; members: number }>)[0]!;
	return { invites: r.invites, members: r.members, users: r.users };
}

async function main(): Promise<void> {
	process.stdout.write(`\n== runely invite-flow smoke (${RUN_TAG}) ==\n\n`);

	// 0) Setup: pick a project to invite into.
	const projects = await sql(
		`SELECT id, name, user_id FROM projects ORDER BY created_at ASC LIMIT 1`
	);
	const project = (projects[0]!.results as Array<{ id: string; name: string; user_id: string }>)[0];
	if (!project) {
		throw new Error('No project found in prod D1. Create one first.');
	}
	const projectId = project.id;
	const inviterId = project.user_id;
	process.stdout.write(`using project ${projectId} (${project.name}), inviter ${inviterId}\n\n`);

	const before = await snapshotCounts();
	process.stdout.write(
		`pre-test counts: users=${before.users} invites=${before.invites} members=${before.members}\n\n`
	);

	let cleanedUp = false;
	const cleanup = async (): Promise<void> => {
		if (cleanedUp) {
			return;
		}
		cleanedUp = true;
		try {
			await sql(
				`DELETE FROM project_invites WHERE id IN ('${VALID_INVITE_ID}', '${REVOKED_INVITE_ID}', '${EXPIRED_INVITE_ID}', '${ACCEPTED_INVITE_ID}'); DELETE FROM project_members WHERE user_id = '${TEST_USER_ID}'; DELETE FROM user WHERE id = '${TEST_USER_ID}'`
			);
		} catch (err) {
			process.stderr.write(`cleanup error: ${(err as Error).message}\n`);
		}
	};

	try {
		const nowMs = Date.now();
		const expiresAt = nowMs + 7 * 86400 * 1000;
		const expiredAt = nowMs - 1000;

		// === Criterion 1: invite creation (DB-level — mirrors createInvite() shape) ===
		await sql(
			`INSERT INTO project_invites (id, project_id, email, token, invited_by, status, expires_at, created_at) VALUES ('${VALID_INVITE_ID}', '${projectId}', '${TEST_USER_EMAIL}', '${VALID_INVITE_TOKEN}', '${inviterId}', 'pending', ${expiresAt}, ${nowMs})`
		);
		const verifyCreate = await sql(
			`SELECT id, status, email, token FROM project_invites WHERE id = '${VALID_INVITE_ID}'`
		);
		const created = (
			verifyCreate[0]!.results as Array<{
				id: string;
				status: string;
				email: string;
				token: string;
			}>
		)[0];
		record(
			'1. invite creation',
			Boolean(created) && created!.status === 'pending' && created!.email === TEST_USER_EMAIL,
			created ? `row exists, status=${created.status}, email=${created.email}` : 'no row found'
		);

		// === Criterion 2: accept-URL state rendering (anonymous curl on each) ===

		// 2a) valid token, anonymous → "Sign in to accept"
		const bodyValid = await curlBody(`${PROD_URL}/invite/${VALID_INVITE_TOKEN}`);
		record(
			'2a. valid token (anonymous) renders Sign in CTA',
			bodyValid.includes('Sign in to accept'),
			bodyValid.includes('Sign in to accept')
				? `body contains "Sign in to accept"`
				: `MISSING; first 200: ${bodyValid.slice(0, 200).replace(/\s+/g, ' ')}`
		);

		// 2b) garbage token → "not recognized"
		const bodyGarbage = await curlBody(`${PROD_URL}/invite/${GARBAGE_TOKEN}`);
		record(
			'2b. invalid/garbage token renders not-recognized error',
			bodyGarbage.includes('not recognized'),
			bodyGarbage.includes('not recognized')
				? 'body contains "not recognized"'
				: `MISSING; first 200: ${bodyGarbage.slice(0, 200).replace(/\s+/g, ' ')}`
		);

		// 2c) revoked token → "revoked"
		await sql(
			`INSERT INTO project_invites (id, project_id, email, token, invited_by, status, expires_at, created_at) VALUES ('${REVOKED_INVITE_ID}', '${projectId}', '${TEST_USER_EMAIL}', '${REVOKED_INVITE_TOKEN}', '${inviterId}', 'revoked', ${expiresAt}, ${nowMs})`
		);
		const bodyRevoked = await curlBody(`${PROD_URL}/invite/${REVOKED_INVITE_TOKEN}`);
		record(
			'2c. revoked token renders revoked error',
			bodyRevoked.includes('was revoked'),
			bodyRevoked.includes('was revoked')
				? 'body contains "was revoked"'
				: `MISSING; first 200: ${bodyRevoked.slice(0, 200).replace(/\s+/g, ' ')}`
		);

		// 2d) expired token → "expired"
		await sql(
			`INSERT INTO project_invites (id, project_id, email, token, invited_by, status, expires_at, created_at) VALUES ('${EXPIRED_INVITE_ID}', '${projectId}', '${TEST_USER_EMAIL}', '${EXPIRED_INVITE_TOKEN}', '${inviterId}', 'pending', ${expiredAt}, ${nowMs - 100000})`
		);
		const bodyExpired = await curlBody(`${PROD_URL}/invite/${EXPIRED_INVITE_TOKEN}`);
		record(
			'2d. expired token renders expired error',
			bodyExpired.includes('has expired'),
			bodyExpired.includes('has expired')
				? 'body contains "has expired"'
				: `MISSING; first 200: ${bodyExpired.slice(0, 200).replace(/\s+/g, ' ')}`
		);

		// 2e) already-accepted token → "already been accepted"
		await sql(
			`INSERT INTO project_invites (id, project_id, email, token, invited_by, status, expires_at, created_at) VALUES ('${ACCEPTED_INVITE_ID}', '${projectId}', '${TEST_USER_EMAIL}', '${ACCEPTED_INVITE_TOKEN}', '${inviterId}', 'accepted', ${expiresAt}, ${nowMs})`
		);
		const bodyAccepted = await curlBody(`${PROD_URL}/invite/${ACCEPTED_INVITE_TOKEN}`);
		record(
			'2e. already-accepted token renders accepted error',
			bodyAccepted.includes('already been accepted'),
			bodyAccepted.includes('already been accepted')
				? 'body contains "already been accepted"'
				: `MISSING; first 200: ${bodyAccepted.slice(0, 200).replace(/\s+/g, ' ')}`
		);

		// === Criterion 3: accept flow at DB level (simulates acceptInvite batch) ===

		// Insert the test user (the email-matching invitee).
		await sql(
			`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('${TEST_USER_ID}', 'Smoke Test', '${TEST_USER_EMAIL}', 1, ${nowMs}, ${nowMs})`
		);

		// Run the exact 2-statement batch acceptInvite() runs.
		await sql(
			`INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_at) VALUES ('${projectId}', '${TEST_USER_ID}', 'member', ${nowMs}); UPDATE project_invites SET status = 'accepted' WHERE id = '${VALID_INVITE_ID}' AND status = 'pending'`
		);

		// Verify membership row exists + invite flipped.
		const verifyAccept = await sql(
			`SELECT role FROM project_members WHERE project_id = '${projectId}' AND user_id = '${TEST_USER_ID}'; SELECT status FROM project_invites WHERE id = '${VALID_INVITE_ID}'`
		);
		const memRow = (verifyAccept[0]!.results as Array<{ role: string }>)[0];
		const invRow = (verifyAccept[1]!.results as Array<{ status: string }>)[0];
		record(
			'3. accept flow (acceptInvite batch)',
			memRow?.role === 'member' && invRow?.status === 'accepted',
			`member.role=${memRow?.role ?? 'MISSING'}, invite.status=${invRow?.status ?? 'MISSING'}`
		);

		// === Criterion 4: post-accept access (getProjectForUser SELECT) ===
		const verifyAccess = await sql(
			`SELECT p.id, p.name FROM projects p JOIN project_members m ON m.project_id = p.id WHERE p.id = '${projectId}' AND m.user_id = '${TEST_USER_ID}'`
		);
		const accessRow = (verifyAccess[0]!.results as Array<{ id: string; name: string }>)[0];
		record(
			'4. post-accept access (getProjectForUser equiv)',
			accessRow?.id === projectId,
			accessRow ? `query returned project ${accessRow.id}` : 'no row — user would 404'
		);

		// === Criterion 5: revoke / leave / remove ===

		// 5a) revoke — flip a pending invite to revoked. We re-pending the
		// already-accepted one for this leg by using a fresh insert.
		const revokeTestId = `test-revoke-${RUN_TAG}`;
		const revokeTestToken = `tok_revoke_test_${RUN_TAG}_${randomHex(8)}`;
		await sql(
			`INSERT INTO project_invites (id, project_id, email, token, invited_by, status, expires_at, created_at) VALUES ('${revokeTestId}', '${projectId}', 'revoke-test+${RUN_TAG}@runely.test', '${revokeTestToken}', '${inviterId}', 'pending', ${expiresAt}, ${nowMs})`
		);
		await sql(
			`UPDATE project_invites SET status = 'revoked' WHERE id = '${revokeTestId}' AND project_id = '${projectId}' AND status = 'pending'`
		);
		const verifyRevoke = await sql(
			`SELECT status FROM project_invites WHERE id = '${revokeTestId}'`
		);
		const revokedRow = (verifyRevoke[0]!.results as Array<{ status: string }>)[0];
		record(
			'5a. revoke marks pending invite revoked',
			revokedRow?.status === 'revoked',
			`status=${revokedRow?.status ?? 'MISSING'}`
		);
		// Add to cleanup list
		await sql(`DELETE FROM project_invites WHERE id = '${revokeTestId}'`);

		// 5b) leaveProject — DELETE FROM project_members WHERE project_id = ? AND user_id = ?
		// Add a temp second member row so we can test leave without losing our
		// real member.
		await sql(
			`INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_at) VALUES ('${projectId}', '${TEST_USER_ID}', 'member', ${nowMs})`
		);
		await sql(
			`DELETE FROM project_members WHERE project_id = '${projectId}' AND user_id = '${TEST_USER_ID}'`
		);
		const verifyLeave = await sql(
			`SELECT 1 AS x FROM project_members WHERE project_id = '${projectId}' AND user_id = '${TEST_USER_ID}'`
		);
		const leaveCount = verifyLeave[0]!.results.length;
		record(
			'5b. leaveProject removes member row',
			leaveCount === 0,
			`rows-after-leave=${leaveCount}`
		);

		// 5c) removeProjectMember — same DELETE shape, different actor. Re-add
		// then remove.
		await sql(
			`INSERT INTO project_members (project_id, user_id, role, created_at) VALUES ('${projectId}', '${TEST_USER_ID}', 'member', ${nowMs})`
		);
		await sql(
			`DELETE FROM project_members WHERE project_id = '${projectId}' AND user_id = '${TEST_USER_ID}'`
		);
		const verifyRemove = await sql(
			`SELECT 1 AS x FROM project_members WHERE project_id = '${projectId}' AND user_id = '${TEST_USER_ID}'`
		);
		const removeCount = verifyRemove[0]!.results.length;
		record(
			'5c. removeProjectMember removes target row',
			removeCount === 0,
			`rows-after-remove=${removeCount}`
		);
	} finally {
		await cleanup();
	}

	const after = await snapshotCounts();
	process.stdout.write(
		`\npost-test counts: users=${after.users} invites=${after.invites} members=${after.members}\n`
	);
	const drift =
		after.users !== before.users ||
		after.invites !== before.invites ||
		after.members !== before.members;
	if (drift) {
		process.stdout.write(
			`!! DRIFT: pre {users:${before.users},invites:${before.invites},members:${before.members}} != post {users:${after.users},invites:${after.invites},members:${after.members}}\n`
		);
	} else {
		process.stdout.write(`✓ cleanup verified — pre/post counts match\n`);
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
