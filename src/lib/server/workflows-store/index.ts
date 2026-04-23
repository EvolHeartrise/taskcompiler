import { getWorkflow } from '$lib/server/db/queries/workflows';
import { type WfpBinding, deleteWorkflow, uploadWorkflow } from '$lib/server/wfp';

// Worker script names: lowercase alphanumeric + hyphens, max 63 chars.
// Workflow IDs are UUIDv4 (36 chars) — `wf-${id}-v${n}` would exceed 63 with
// Versions of 5+ digits, so we truncate to the first 12 hex chars. That keeps
// Names ≤ 63 chars (`wf-` 3 + 12 + `-v` 2 + version digits) and is unique
// Enough in practice given the workflow_id namespace.
const WORKFLOW_ID_PREFIX_LEN = 12;

function workflowIdSlug(workflowId: string): string {
	return workflowId.replaceAll('-', '').slice(0, WORKFLOW_ID_PREFIX_LEN);
}

export function workflowScriptName(workflowId: string, version: number): string {
	return `wf-${workflowIdSlug(workflowId)}-v${version}`;
}

export function testScriptName(workflowId: string, nonce: string): string {
	return `test-${workflowIdSlug(workflowId)}-${nonce}`;
}

// USER_ID is baked into every workflow script at upload time so the
// Bootstrap can query `user_secrets WHERE user_id = ?` at runtime.
// Never changes after creation; secret values live in D1 and are loaded
// Lazily per invocation.
export function userIdBinding(userId: string): WfpBinding {
	return { name: 'USER_ID', text: userId, type: 'plain_text' };
}

export async function writeVersion(
	workflowId: string,
	version: number,
	sourceTs: string
): Promise<string> {
	const workflow = await getWorkflow(workflowId);
	if (!workflow) {
		throw new Error(`writeVersion: workflow not found: ${workflowId}`);
	}
	const scriptName = workflowScriptName(workflowId, version);
	await uploadWorkflow({
		bindings: [userIdBinding(workflow.userId)],
		scriptName,
		userSourceTs: sourceTs
	});
	return scriptName;
}

export async function deleteWorkflowVersion(scriptName: string): Promise<void> {
	await deleteWorkflow(scriptName);
}
