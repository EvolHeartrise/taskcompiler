import { startCron } from "./cron.ts";

let booted = false;

export function bootstrapTriggers(): void {
	if (booted) return;
	booted = true;
	startCron();
}
