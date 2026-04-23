import type { Cookies } from '@sveltejs/kit';

export const PROJECT_COOKIE = 'runely_project';

export function setProjectCookie(cookies: Cookies, projectId: string, secure: boolean): void {
	cookies.set(PROJECT_COOKIE, projectId, {
		httpOnly: true,
		maxAge: 60 * 60 * 24 * 365,
		path: '/',
		sameSite: 'lax',
		secure
	});
}
