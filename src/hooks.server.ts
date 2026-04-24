import { redirect, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
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

const authHandler: Handle = ({ event, resolve }) =>
	svelteKitHandler({ event, resolve, auth: auth(), building });

const sessionHandler: Handle = async ({ event, resolve }) => {
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

export const handle: Handle = sequence(authHandler, sessionHandler);
