// Dev/manual-test endpoint. `vite dev` doesn't fire `scheduled` handlers, so
// this command lets us invoke the cron tick logic on demand.
import { command } from '$app/server';
import { handleCronTick } from '$lib/server/triggers/cron-handler';

export const runCronTick = command(async () => handleCronTick());
