import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url, platform }) => {
	if (locals.user) {
		const next = url.searchParams.get('next') ?? '/';
		throw redirect(303, next);
	}
	const env = platform?.env;
	return {
		googleEnabled: Boolean(env?.GOOGLE_CLIENT_ID && env?.GOOGLE_CLIENT_SECRET)
	};
};
