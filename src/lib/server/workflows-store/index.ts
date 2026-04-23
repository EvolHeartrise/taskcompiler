import { deleteWorkflow as deleteWorkflowRow, getWorkflow } from '$lib/server/db/queries/workflows';
import { listVersions } from '$lib/server/db/queries/versions';
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

// PROJECT_ID is baked into every workflow script at upload time so the
// Bootstrap can query `project_secrets WHERE project_id = ?` at runtime.
// Never changes after creation; secret values live in D1 and are loaded
// Lazily per invocation.
export function projectIdBinding(projectId: string): WfpBinding {
	return { name: 'PROJECT_ID', text: projectId, type: 'plain_text' };
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
		bindings: [projectIdBinding(workflow.projectId)],
		scriptName,
		userSourceTs: sourceTs
	});
	return scriptName;
}

export interface TearDownResult {
	scriptsDeleted: number;
	scriptsFailed: number;
	dbDeleted: boolean;
}

/**
 * Delete a workflow and every artifact we own for it: every deployed WFP
 * script (one per version) plus the DB rows. WFP script deletes are best-
 * effort — a failed script delete is logged but does not block the DB
 * delete, since leaving a workflow row pointing at missing scripts is
 * worse than leaving orphan scripts (those can be cleaned up later).
 */
export async function tearDownWorkflow(workflowId: string): Promise<TearDownResult> {
	const versions = await listVersions(workflowId);
	let scriptsDeleted = 0;
	let scriptsFailed = 0;
	for (const v of versions) {
		try {
			await deleteWorkflow(v.deployPath);
			scriptsDeleted += 1;
		} catch (error) {
			scriptsFailed += 1;
			console.error('[teardown] WFP delete failed', {
				error: error instanceof Error ? error.message : String(error),
				scriptName: v.deployPath,
				workflowId
			});
		}
	}
	const dbDeleted = await deleteWorkflowRow(workflowId);
	return { dbDeleted, scriptsDeleted, scriptsFailed };
}
