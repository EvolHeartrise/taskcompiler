// Dev/manual-test endpoint. `vite dev` doesn't fire `scheduled` handlers, so
// this route lets us invoke the cron tick logic on demand. Open in production
// during M4 for parity with the rest of the app (no auth yet); gate or remove
// once auth lands.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { handleCronTick } from '$lib/server/triggers/cron-handler';

export const POST: RequestHandler = async () => {
	const result = await handleCronTick();
	return json(result);
};
