import { redirect, type Handle } from '@sveltejs/kit';
import { withEnv } from '$lib/server/env';
import { auth } from '$lib/server/auth';

function isPublic(pathname: string): boolean {
	if (pathname === '/auth' || pathname.startsWith('/auth/')) {
		return true;
	}
	if (pathname.startsWith('/api/auth/')) {
		return true;
	}
	if (pathname.startsWith('/hook/')) {
		return true; // webhook endpoints are external
	}
	if (pathname === '/api/dev/cron-tick') {
		return true; // dev-only trigger
	}
	return false;
}

export const handle: Handle = async ({ event, resolve }) => {
	if (!event.platform) {
		return resolve(event);
	}
	return withEnv(event.platform.env, async () => {
		const session = await auth().api.getSession({ headers: event.request.headers });
		event.locals.user = session?.user
			? {
					id: session.user.id,
					email: session.user.email,
					name: session.user.name ?? session.user.email,
					image: session.user.image ?? null
				}
			: null;
		event.locals.session = session?.session
			? {
					id: session.session.id,
					token: session.session.token,
					expiresAt: session.session.expiresAt,
					userId: session.session.userId
				}
			: null;

		if (!event.locals.user && !isPublic(event.url.pathname)) {
			const next = event.url.pathname + event.url.search;
			throw redirect(303, `/auth?next=${encodeURIComponent(next)}`);
		}

		return resolve(event);
	});
};
