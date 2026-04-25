import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { acceptInvite as acceptInviteRow, getInviteByToken } from '$lib/server/db/queries/invites';
import { getProject } from '$lib/server/db/queries/projects';
import { createLogger } from '$lib/server/log';
import { EVENTS } from '$lib/server/log-events';

const log = createLogger('invites');

type LoadState =
	| { kind: 'invalid'; reason: string }
	| { kind: 'expired' }
	| { kind: 'revoked' }
	| { kind: 'accepted' }
	| { kind: 'unauthenticated'; email: string; projectName: string; nextUrl: string }
	| {
			kind: 'wrong_account';
			inviteEmail: string;
			currentEmail: string;
			projectName: string;
			nextUrl: string;
	  }
	| { kind: 'ready'; projectName: string; projectId: string; inviteEmail: string };

export interface InviteLoadData {
	state: LoadState;
}

export const load: PageServerLoad = async ({
	params,
	platform,
	locals,
	url
}): Promise<InviteLoadData> => {
	const env = platform!.env;
	const db = getDb(env);
	const token = params.token;
	const invite = await getInviteByToken(db, token);
	if (!invite) {
		return { state: { kind: 'invalid', reason: 'This invite link is not recognized.' } };
	}
	if (invite.status === 'revoked') {
		return { state: { kind: 'revoked' } };
	}
	if (invite.status === 'accepted') {
		return { state: { kind: 'accepted' } };
	}
	if (invite.status === 'expired' || invite.expiresAt < Date.now()) {
		return { state: { kind: 'expired' } };
	}
	const project = await getProject(db, invite.projectId);
	const projectName = project?.name ?? 'a project';
	// Preserve the current URL so the auth round-trip lands the invitee back
	// on this page after sign-in. `/auth` already honors `?next=`.
	const nextUrl = url.pathname;
	if (!locals.user) {
		return {
			state: { email: invite.email, kind: 'unauthenticated', nextUrl, projectName }
		};
	}
	if ((locals.user.email ?? '').toLowerCase() !== invite.email.toLowerCase()) {
		return {
			state: {
				currentEmail: locals.user.email ?? '',
				inviteEmail: invite.email,
				kind: 'wrong_account',
				nextUrl,
				projectName
			}
		};
	}
	return {
		state: {
			inviteEmail: invite.email,
			kind: 'ready',
			projectId: invite.projectId,
			projectName
		}
	};
};

export const actions: Actions = {
	accept: async ({ params, platform, locals }) => {
		if (!locals.user) {
			return fail(401, { error: 'Sign in to accept this invite.' });
		}
		const env = platform!.env;
		const db = getDb(env);
		const invite = await getInviteByToken(db, params.token);
		if (!invite) {
			return fail(404, { error: 'This invite link is not recognized.' });
		}
		if (invite.status !== 'pending') {
			return fail(400, { error: `This invite is ${invite.status}.` });
		}
		if (invite.expiresAt < Date.now()) {
			return fail(400, { error: 'This invite has expired.' });
		}
		if ((locals.user.email ?? '').toLowerCase() !== invite.email.toLowerCase()) {
			return fail(403, { error: 'This invite was sent to a different email address.' });
		}
		await acceptInviteRow(db, {
			inviteId: invite.id,
			now: Date.now(),
			projectId: invite.projectId,
			role: invite.role,
			userId: locals.user.id
		});
		log.info(EVENTS.INVITE_ACCEPTED, {
			invite_id: invite.id,
			project_id: invite.projectId,
			user_id: locals.user.id
		});
		throw redirect(303, `/p/${invite.projectId}`);
	}
};
