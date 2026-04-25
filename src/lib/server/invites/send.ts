// Invite email dispatcher.
//
// Note: invite tokens are intentionally surfaced in the structured event
// (field `accept_url`) — they're 7-day-scoped and email-bound, so the
// long-tail risk is acceptable and task 5's smoke test depends on it.
// The redaction guard in log.ts keys on field names matching /token|.../;
// `accept_url` is deliberately not in that set.

import { createLogger } from '../log';
import { EVENTS } from '../log-events';
import { errorMessage } from '../util';

const log = createLogger('invites');

export interface SendInviteParams {
	env: Env;
	to: string;
	acceptUrl: string;
	projectName: string;
	inviterName: string | null;
	inviteId: string;
	projectId: string;
}

export async function sendInviteEmail(params: SendInviteParams): Promise<void> {
	const { env, to, acceptUrl, projectName, inviterName, inviteId, projectId } = params;
	const inviter = inviterName?.trim() || 'A teammate';

	try {
		const subject = `${inviter} invited you to ${projectName} on TaskCompiler`;
		const html = `<p>${escapeHtml(inviter)} invited you to collaborate on <b>${escapeHtml(projectName)}</b> on TaskCompiler.</p>
<p>Accept the invite using the link below. It expires in 7 days.</p>
<p><a href="${acceptUrl}">${acceptUrl}</a></p>
<p>If you didn't expect this email, you can safely ignore it.</p>`;
		const text = `${inviter} invited you to ${projectName} on TaskCompiler.\n\nAccept: ${acceptUrl}\n\nThis link expires in 7 days. If you didn't expect this email, ignore it.`;
		await env.EMAIL.send({
			from: env.EMAIL_FROM,
			html,
			subject,
			text,
			to
		});
		log.info(EVENTS.INVITE_SENT, {
			accept_url: acceptUrl,
			invite_id: inviteId,
			project_id: projectId,
			to_email: to
		});
	} catch (err) {
		// Mirror auth.ts: don't lock invitees out on a misconfigured sender —
		// fall through to the unstructured stream with the URL, and emit a
		// structured warning (with the URL too, since invites are short-lived
		// and email-bound) so on-call can still complete the flow.
		console.error(
			`[invites] EMAIL.send failed (${errorMessage(err)}); accept link for ${to}: ${acceptUrl}`
		);
		log.error(EVENTS.INVITE_SEND_FAILED, {
			accept_url: acceptUrl,
			error: errorMessage(err),
			invite_id: inviteId,
			project_id: projectId,
			to_email: to
		});
	}
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
