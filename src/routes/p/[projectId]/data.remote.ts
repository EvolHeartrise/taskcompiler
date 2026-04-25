import { error } from '@sveltejs/kit';
import { command, getRequestEvent, query } from '$app/server';
import { requireCan } from '$lib/server/auth/permissions';
import { getDb } from '$lib/server/db';
import {
	createInvite,
	generateInviteToken,
	getInviteForProject,
	listProjectInvites,
	listProjectMembers,
	listPendingInvitesForEmail,
	removeMember,
	revokeInvite
} from '$lib/server/db/queries/invites';
import { getProjectForUser } from '$lib/server/db/queries/projects';
import type { InviteRole, InviteStatus, ProjectRole } from '$lib/server/db/types';
import { sendInviteEmail } from '$lib/server/invites/send';
import { createLogger } from '$lib/server/log';
import { EVENTS } from '$lib/server/log-events';
import { errorMessage } from '$lib/server/util';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_MAX_LEN = 254; // RFC 5321 practical cap.

const log = createLogger('invites');

interface MembershipMember {
	userId: string;
	name: string;
	email: string;
	role: ProjectRole;
	joinedAt: number;
}

interface MembershipInvite {
	id: string;
	email: string;
	role: InviteRole;
	status: InviteStatus;
	expiresAt: number;
	createdAt: number;
	invitedBy: string;
}

export interface MembershipData {
	members: MembershipMember[];
	invites: MembershipInvite[];
}

async function requireProjectMembership(
	projectId: string
): Promise<{ env: Env; userId: string; role: ProjectRole }> {
	const event = getRequestEvent();
	if (!event.locals.user) {
		error(401, 'unauthorized');
	}
	const env = event.platform!.env;
	const result = await getProjectForUser(getDb(env), projectId, event.locals.user.id);
	if (!result) {
		error(404, 'Project not found');
	}
	return { env, role: result.role, userId: event.locals.user.id };
}

function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

function isPlausibleEmail(email: string): boolean {
	if (email.length === 0 || email.length > EMAIL_MAX_LEN) {
		return false;
	}
	const at = email.indexOf('@');
	if (at <= 0 || at !== email.lastIndexOf('@')) {
		return false;
	}
	if (at === email.length - 1) {
		return false;
	}
	if (email.includes(' ')) {
		return false;
	}
	return true;
}

// Combined query: members + pending invites for the project. Folded together
// because the UI (task 4) renders them in one panel and a single round-trip
// keeps the layout from popping in two stages.
//
// Read endpoint — gated by project membership only. Role-specific gating
// happens on the mutating commands below.
export const getProjectMembership = query(
	'unchecked',
	async ({ projectId }: { projectId: string }): Promise<MembershipData> => {
		const { env } = await requireProjectMembership(projectId);
		const db = getDb(env);
		const [members, invites] = await Promise.all([
			listProjectMembers(db, projectId),
			listProjectInvites(db, projectId)
		]);
		return {
			invites: invites
				.filter((i) => i.status === 'pending')
				.map((i) => ({
					createdAt: i.createdAt,
					email: i.email,
					expiresAt: i.expiresAt,
					id: i.id,
					invitedBy: i.invitedBy,
					role: i.role,
					status: i.status
				})),
			members: members.map((m) => ({
				email: m.email,
				joinedAt: m.joinedAt,
				name: m.name,
				role: m.role,
				userId: m.userId
			}))
		};
	}
);

type CreateInviteResult = { ok: true; inviteId: string } | { ok: false; error: string };

export const createProjectInvite = command(
	'unchecked',
	async ({
		projectId,
		email,
		role
	}: {
		projectId: string;
		email: string;
		role?: InviteRole;
	}): Promise<CreateInviteResult> => {
		const { env, role: callerRole, userId } = await requireProjectMembership(projectId);
		// Validate the requested invite role first — reject 'owner' explicitly
		// because ownership is transferred, never invited.
		const requestedRole: InviteRole = role ?? 'editor';
		// `as string` so a malicious client passing 'owner' is caught here even
		// though the static type forbids it.
		if ((requestedRole as string) === 'owner') {
			return { error: "Cannot invite as 'owner'. Transfer ownership instead.", ok: false };
		}
		if (requestedRole !== 'admin' && requestedRole !== 'editor') {
			return { error: `Invalid role '${String(requestedRole)}'.`, ok: false };
		}
		// Caller must be allowed to invite at all, AND specifically allowed to
		// invite at the requested role tier.
		requireCan(callerRole, 'member.invite');
		requireCan(callerRole, requestedRole === 'admin' ? 'invite.role.admin' : 'invite.role.editor');
		const event = getRequestEvent();
		const db = getDb(env);

		const normalized = normalizeEmail(email ?? '');
		if (!isPlausibleEmail(normalized)) {
			return { error: 'Enter a valid email address.', ok: false };
		}

		// Reject if email is already a project member. The members table joins
		// to `user.email`, which is unique — direct compare is sufficient.
		const members = await listProjectMembers(db, projectId);
		if (members.some((m) => m.email.toLowerCase() === normalized)) {
			return { error: 'That person is already a member of this project.', ok: false };
		}

		// Reject if there is already an outstanding pending invite for this email.
		const existing = await listPendingInvitesForEmail(db, projectId, normalized);
		if (existing.length > 0) {
			return { error: 'An invite for that email is already pending.', ok: false };
		}

		const token = generateInviteToken();
		const expiresAt = Date.now() + INVITE_TTL_MS;
		let inviteId: string;
		try {
			const invite = await createInvite(db, {
				email: normalized,
				expiresAt,
				invitedBy: userId,
				projectId,
				role: requestedRole,
				token
			});
			inviteId = invite.id;
		} catch (err) {
			return { error: `Could not create invite: ${errorMessage(err)}`, ok: false };
		}

		log.info(EVENTS.INVITE_CREATED, {
			invite_id: inviteId,
			invited_by: userId,
			project_id: projectId,
			role: requestedRole,
			to_email: normalized
		});

		const baseUrl = env.APP_URL ?? new URL(event.request.url).origin;
		const acceptUrl = `${baseUrl.replace(/\/$/, '')}/invite/${token}`;
		const projectResult = await getProjectForUser(db, projectId, userId);
		await sendInviteEmail({
			acceptUrl,
			env,
			inviteId,
			inviterName: event.locals.user?.name ?? null,
			projectId,
			projectName: projectResult?.project.name ?? 'a project',
			to: normalized
		});

		void getProjectMembership({ projectId }).refresh();
		return { inviteId, ok: true };
	}
);

type RevokeResult = { ok: true } | { ok: false; error: string };

export const revokeProjectInvite = command(
	'unchecked',
	async ({
		projectId,
		inviteId
	}: {
		projectId: string;
		inviteId: string;
	}): Promise<RevokeResult> => {
		const { env, role, userId } = await requireProjectMembership(projectId);
		requireCan(role, 'invite.revoke');
		const db = getDb(env);
		const invite = await getInviteForProject(db, inviteId, projectId);
		if (!invite) {
			return { error: 'Invite not found.', ok: false };
		}
		if (invite.status !== 'pending') {
			return { error: `Cannot revoke a ${invite.status} invite.`, ok: false };
		}
		await revokeInvite(db, inviteId, projectId);
		log.info(EVENTS.INVITE_REVOKED, {
			invite_id: inviteId,
			project_id: projectId,
			revoked_by: userId
		});
		void getProjectMembership({ projectId }).refresh();
		return { ok: true };
	}
);

type LeaveResult = { ok: true } | { ok: false; error: string };

export const leaveProject = command(
	'unchecked',
	async ({ projectId }: { projectId: string }): Promise<LeaveResult> => {
		const { env, role, userId } = await requireProjectMembership(projectId);
		const db = getDb(env);
		// Sole-owner guard: an owner can self-leave only if they are the only
		// member of the project, OR if there are other members AND ownership
		// has already been transferred elsewhere. Owner-with-others must use
		// transferOwnership (task 8) before leaving.
		if (role === 'owner') {
			const members = await listProjectMembers(db, projectId);
			const otherMembers = members.filter((m) => m.userId !== userId);
			const otherOwners = otherMembers.filter((m) => m.role === 'owner');
			if (otherMembers.length > 0 && otherOwners.length === 0) {
				return {
					error: "You're the sole owner. Transfer ownership to another member before leaving.",
					ok: false
				};
			}
		}
		// requireProjectMembership already established membership via
		// getProjectForUser; redundant isProjectMember check would be a no-op.
		await removeMember(db, projectId, userId);
		log.info(EVENTS.PROJECT_MEMBER_LEFT, {
			project_id: projectId,
			user_id: userId
		});
		void getProjectMembership({ projectId }).refresh();
		return { ok: true };
	}
);

type RemoveMemberResult = { ok: true } | { ok: false; error: string };

export const removeProjectMember = command(
	'unchecked',
	async ({
		projectId,
		userId
	}: {
		projectId: string;
		userId: string;
	}): Promise<RemoveMemberResult> => {
		const { env, role, userId: actorId } = await requireProjectMembership(projectId);
		requireCan(role, 'member.remove');
		if (!userId) {
			return { error: 'userId is required.', ok: false };
		}
		const db = getDb(env);
		// Lookup target's role too, so we can refuse to remove the owner.
		// `isProjectMember` is a 1/0 probe — read the row instead.
		const members = await listProjectMembers(db, projectId);
		const target = members.find((m) => m.userId === userId);
		if (!target) {
			return { error: 'That user is not a member of this project.', ok: false };
		}
		if (target.role === 'owner') {
			return {
				error: 'Cannot remove the owner. Transfer ownership first.',
				ok: false
			};
		}
		await removeMember(db, projectId, userId);
		log.info(EVENTS.PROJECT_MEMBER_REMOVED, {
			project_id: projectId,
			removed_by: actorId,
			user_id: userId
		});
		void getProjectMembership({ projectId }).refresh();
		return { ok: true };
	}
);
