import { getDb } from '$lib/server/db';
import { deleteWorkflow as deleteWorkflowRow, getWorkflow } from '$lib/server/db/queries/workflows';
import { listVersions } from '$lib/server/db/queries/versions';
import { errorMessage } from '$lib/server/util';
import { type WfpBinding, deleteWorkflow, uploadWorkflow } from '$lib/server/wfp';

// Worker script names max out at 63 chars. With the 36-char UUIDv4 workflow
// id, `wf-${id}-v${n}` would exceed that for 5+ digit versions, so we take
// the first 12 hex chars — unique enough within a project's namespace.
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

// Baked in at upload so the bootstrap can query
// `project_secrets WHERE project_id = ?` at runtime.
export function projectIdBinding(projectId: string): WfpBinding {
	return { name: 'PROJECT_ID', text: projectId, type: 'plain_text' };
}

export async function writeVersion(
	env: Env,
	workflowId: string,
	version: number,
	sourceTs: string
): Promise<string> {
	const workflow = await getWorkflow(getDb(env), workflowId);
	if (!workflow) {
		throw new Error(`writeVersion: workflow not found: ${workflowId}`);
	}
	const scriptName = workflowScriptName(workflowId, version);
	await uploadWorkflow(env, {
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

// WFP script deletes are best-effort: a failed delete is logged but doesn't
// block the DB delete, since a workflow row pointing at missing scripts is
// worse than orphan scripts (which can be cleaned up later).
export async function tearDownWorkflow(env: Env, workflowId: string): Promise<TearDownResult> {
	const db = getDb(env);
	const versions = await listVersions(db, workflowId);
	let scriptsDeleted = 0;
	let scriptsFailed = 0;
	for (const v of versions) {
		try {
			await deleteWorkflow(env, v.deployPath);
			scriptsDeleted += 1;
		} catch (error) {
			scriptsFailed += 1;
			console.error('[teardown] WFP delete failed', {
				error: errorMessage(error),
				scriptName: v.deployPath,
				workflowId
			});
		}
	}
	const dbDeleted = await deleteWorkflowRow(db, workflowId);
	return { dbDeleted, scriptsDeleted, scriptsFailed };
}
