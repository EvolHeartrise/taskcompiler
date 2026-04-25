import { now, uuid } from '../index.ts';
import { fetchAll, fetchOne } from '../mappers.ts';
import type { Invite, InviteRole, InviteStatus, ProjectMember, ProjectRole } from '../types.ts';

// Roles assignable via `updateMemberRole`. Owner is excluded — ownership moves
// exclusively through `transferOwnership` (a 2-row atomic batch) so the
// single-owner invariant survives even without a DB-level constraint.
export type AssignableRole = Exclude<ProjectRole, 'owner'>;

interface InviteRow {
	id: string;
	project_id: string;
	email: string;
	token: string;
	invited_by: string;
	status: InviteStatus;
	role: InviteRole;
	expires_at: number;
	created_at: number;
}

interface ProjectMemberJoinRow {
	user_id: string;
	name: string;
	email: string;
	role: ProjectRole;
	joined_at: number;
}

export interface CreateInviteInput {
	id?: string;
	projectId: string;
	email: string;
	invitedBy: string;
	token: string;
	role: InviteRole;
	expiresAt: number;
}

// Token generator — 32 hex chars (128 bits) from crypto.getRandomValues. Long
// enough that brute-forcing the public /invite/[token] surface is hopeless,
// short enough that the URL stays scannable in logs.
export function generateInviteToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createInvite(db: D1Database, input: CreateInviteInput): Promise<Invite> {
	const id = input.id ?? uuid();
	const ts = now();
	await db
		.prepare(
			`INSERT INTO project_invites
			 (id, project_id, email, token, invited_by, status, role, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
		)
		.bind(
			id,
			input.projectId,
			input.email,
			input.token,
			input.invitedBy,
			input.role,
			input.expiresAt,
			ts
		)
		.run();
	return {
		createdAt: ts,
		email: input.email,
		expiresAt: input.expiresAt,
		id,
		invitedBy: input.invitedBy,
		projectId: input.projectId,
		role: input.role,
		status: 'pending',
		token: input.token
	};
}

export async function listProjectInvites(db: D1Database, projectId: string): Promise<Invite[]> {
	return fetchAll<InviteRow, Invite>(
		db
			.prepare(
				`SELECT * FROM project_invites
				 WHERE project_id = ?
				 ORDER BY created_at DESC`
			)
			.bind(projectId)
	);
}

export async function listPendingInvitesForEmail(
	db: D1Database,
	projectId: string,
	email: string
): Promise<Invite[]> {
	return fetchAll<InviteRow, Invite>(
		db
			.prepare(
				`SELECT * FROM project_invites
				 WHERE project_id = ? AND email = ? AND status = 'pending'`
			)
			.bind(projectId, email)
	);
}

export async function getInviteByToken(db: D1Database, token: string): Promise<Invite | null> {
	return fetchOne<InviteRow, Invite>(
		db.prepare(`SELECT * FROM project_invites WHERE token = ?`).bind(token)
	);
}

export async function getInviteForProject(
	db: D1Database,
	inviteId: string,
	projectId: string
): Promise<Invite | null> {
	return fetchOne<InviteRow, Invite>(
		db
			.prepare(`SELECT * FROM project_invites WHERE id = ? AND project_id = ?`)
			.bind(inviteId, projectId)
	);
}

// Caller must gate authz before calling.
export async function revokeInvite(
	db: D1Database,
	inviteId: string,
	projectId: string
): Promise<void> {
	await db
		.prepare(
			`UPDATE project_invites SET status = 'revoked'
			 WHERE id = ? AND project_id = ? AND status = 'pending'`
		)
		.bind(inviteId, projectId)
		.run();
}

export interface AcceptInviteInput {
	inviteId: string;
	projectId: string;
	userId: string;
	now: number;
}

// Atomic accept: insert membership row + flip invite status in one D1 batch
// so a partial application can't strand an "accepted" invite without a
// member row (or vice versa). The membership row is created with the role
// recorded on the invite at issue time.
export async function acceptInvite(
	db: D1Database,
	input: AcceptInviteInput & { role: InviteRole }
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_at)
				 VALUES (?, ?, ?, ?)`
			)
			.bind(input.projectId, input.userId, input.role, input.now),
		db
			.prepare(
				`UPDATE project_invites SET status = 'accepted'
				 WHERE id = ? AND status = 'pending'`
			)
			.bind(input.inviteId)
	]);
}

export async function listProjectMembers(
	db: D1Database,
	projectId: string
): Promise<ProjectMember[]> {
	return fetchAll<ProjectMemberJoinRow, ProjectMember>(
		db
			.prepare(
				`SELECT m.user_id, u.name, u.email, m.role, m.created_at AS joined_at
				 FROM project_members m
				 JOIN user u ON u.id = m.user_id
				 WHERE m.project_id = ?
				 ORDER BY m.created_at ASC`
			)
			.bind(projectId)
	);
}

export async function isProjectMember(
	db: D1Database,
	projectId: string,
	userId: string
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 AS x FROM project_members WHERE project_id = ? AND user_id = ?`)
		.bind(projectId, userId)
		.first<{ x: number }>();
	return row !== null;
}

export async function removeMember(
	db: D1Database,
	projectId: string,
	userId: string
): Promise<void> {
	await db
		.prepare(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`)
		.bind(projectId, userId)
		.run();
}

// Caller must gate authz before calling. Refuses to overwrite an existing
// `owner` row by clause — owner moves exclusively via `transferOwnership`.
export async function updateMemberRole(
	db: D1Database,
	projectId: string,
	userId: string,
	newRole: AssignableRole
): Promise<void> {
	await db
		.prepare(
			`UPDATE project_members SET role = ?
			 WHERE project_id = ? AND user_id = ? AND role != 'owner'`
		)
		.bind(newRole, projectId, userId)
		.run();
}

// Atomic ownership swap. Owner uniqueness is not enforced at the DB level so
// the two updates MUST land in a single `db.batch(...)` to keep "exactly one
// owner per project" intact under concurrent calls. Old owner is demoted to
// `admin` so they remain in the project with elevated powers and can later
// leave or be removed normally.
export async function transferOwnership(
	db: D1Database,
	projectId: string,
	fromUserId: string,
	toUserId: string
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`UPDATE project_members SET role = 'admin'
				 WHERE project_id = ? AND user_id = ? AND role = 'owner'`
			)
			.bind(projectId, fromUserId),
		db
			.prepare(
				`UPDATE project_members SET role = 'owner'
				 WHERE project_id = ? AND user_id = ?`
			)
			.bind(projectId, toUserId)
	]);
}
