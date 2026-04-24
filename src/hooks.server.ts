import { redirect, type Handle } from '@sveltejs/kit';
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
	const result = await auth().api.getSession({ headers: event.request.headers });
	event.locals.user = result?.user ?? null;
	event.locals.session = result?.session ?? null;

	if (!event.locals.user && !isPublic(event.url.pathname)) {
		const next = event.url.pathname + event.url.search;
		throw redirect(303, `/auth?next=${encodeURIComponent(next)}`);
	}

	return resolve(event);
};
