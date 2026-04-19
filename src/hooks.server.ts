import type { Handle } from '@sveltejs/kit';
import { withEnv } from '$lib/server/env';
import { wireHealer } from '$lib/server/healer';

let healerWired = false;

export const handle: Handle = async ({ event, resolve }) => {
	if (!healerWired) {
		wireHealer();
		healerWired = true;
	}
	if (!event.platform) {
		return resolve(event);
	}
	return withEnv(event.platform.env, async () => resolve(event));
};
