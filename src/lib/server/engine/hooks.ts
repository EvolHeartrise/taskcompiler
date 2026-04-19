export interface RunFailedContext {
	runId: string;
	workflowId: string;
	eventId: string;
}

export type RunFailedHook = (ctx: RunFailedContext) => void | Promise<void>;

let hook: RunFailedHook = () => {};

export function setRunFailedHook(h: RunFailedHook): void {
	hook = h;
}

export function getRunFailedHook(): RunFailedHook {
	return hook;
}
