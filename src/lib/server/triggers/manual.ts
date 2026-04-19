import { executeEvent } from "$lib/server/engine";

type ExecuteResult = Awaited<ReturnType<typeof executeEvent>>;

export async function triggerManual(workflowId: string, payload: unknown): Promise<ExecuteResult> {
	return executeEvent({ workflowId, trigger: "manual", payload });
}
