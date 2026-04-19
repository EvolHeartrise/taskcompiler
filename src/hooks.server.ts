import type { Handle } from '@sveltejs/kit';
import { withEnv } from '$lib/server/env';

export const handle: Handle = async ({ event, resolve }) => {
	if (!event.platform) {
		return resolve(event);
	}
	return withEnv(event.platform.env, async () => resolve(event));
};
