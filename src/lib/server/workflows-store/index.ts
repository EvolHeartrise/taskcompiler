import { uploadWorkflow, deleteWorkflow } from "$lib/server/wfp";

// Worker script names: lowercase alphanumeric + hyphens, max 63 chars.
// Workflow IDs are UUIDv4 (36 chars) — `wf-${id}-v${n}` would exceed 63 with
// versions of 5+ digits, so we truncate to the first 12 hex chars. That keeps
// names ≤ 63 chars (`wf-` 3 + 12 + `-v` 2 + version digits) and is unique
// enough in practice given the workflow_id namespace.
const WORKFLOW_ID_PREFIX_LEN = 12;

function workflowIdSlug(workflowId: string): string {
	return workflowId.replace(/-/g, "").slice(0, WORKFLOW_ID_PREFIX_LEN);
}

export function workflowScriptName(workflowId: string, version: number): string {
	return `wf-${workflowIdSlug(workflowId)}-v${version}`;
}

export function testScriptName(workflowId: string, nonce: string): string {
	return `test-${workflowIdSlug(workflowId)}-${nonce}`;
}

export async function writeVersion(
	workflowId: string,
	version: number,
	sourceTs: string,
): Promise<string> {
	const scriptName = workflowScriptName(workflowId, version);
	await uploadWorkflow({ scriptName, userSourceTs: sourceTs });
	return scriptName;
}

export async function deleteWorkflowVersion(scriptName: string): Promise<void> {
	await deleteWorkflow(scriptName);
}
