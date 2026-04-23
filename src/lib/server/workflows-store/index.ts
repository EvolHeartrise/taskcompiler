import { getSecretsForUser } from '$lib/server/db/queries/secrets';
import { getWorkflow, listWorkflowsForUser } from '$lib/server/db/queries/workflows';
import { getCurrentVersion } from '$lib/server/db/queries/versions';
import { type WfpBinding, deleteWorkflow, uploadWorkflow } from '$lib/server/wfp';

// Worker script names: lowercase alphanumeric + hyphens, max 63 chars.
// Workflow IDs are UUIDv4 (36 chars) — `wf-${id}-v${n}` would exceed 63 with
// Versions of 5+ digits, so we truncate to the first 12 hex chars. That keeps
// Names ≤ 63 chars (`wf-` 3 + 12 + `-v` 2 + version digits) and is unique
// Enough in practice given the workflow_id namespace.
const WORKFLOW_ID_PREFIX_LEN = 12;

function workflowIdSlug(workflowId: string): string {
	return workflowId.replaceAll(/-/g, '').slice(0, WORKFLOW_ID_PREFIX_LEN);
}

export function workflowScriptName(workflowId: string, version: number): string {
	return `wf-${workflowIdSlug(workflowId)}-v${version}`;
}

export function testScriptName(workflowId: string, nonce: string): string {
	return `test-${workflowIdSlug(workflowId)}-${nonce}`;
}

export async function buildSecretBindings(userId: string): Promise<WfpBinding[]> {
	const secrets = await getSecretsForUser(userId);
	return secrets.map((s) => ({ name: s.name, text: s.value, type: 'secret_text' as const }));
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
	const bindings = await buildSecretBindings(workflow.userId);
	const scriptName = workflowScriptName(workflowId, version);
	await uploadWorkflow({ bindings, scriptName, userSourceTs: sourceTs });
	return scriptName;
}

export async function deleteWorkflowVersion(scriptName: string): Promise<void> {
	await deleteWorkflow(scriptName);
}

/**
 * Re-upload every current workflow version owned by this user with the
 * latest secret bindings. Called after a user secret is added/updated/deleted
 * so running workflows pick up the new env without waiting for a new deploy.
 * Failures on any individual workflow are logged and swallowed — the rest
 * still redeploy.
 */
export async function redeployUserCurrentVersions(userId: string): Promise<{
	attempted: number;
	ok: number;
	failed: number;
}> {
	const workflows = await listWorkflowsForUser(userId);
	const bindings = await buildSecretBindings(userId);
	let attempted = 0;
	let ok = 0;
	let failed = 0;
	for (const wf of workflows) {
		if (!wf.currentVersionId) {
			continue;
		}
		const version = await getCurrentVersion(wf.id);
		if (!version) {
			continue;
		}
		attempted += 1;
		try {
			await uploadWorkflow({
				bindings,
				scriptName: version.deployPath,
				userSourceTs: version.sourceTs
			});
			ok += 1;
		} catch (error) {
			failed += 1;
			console.error('[secrets] redeploy failed', {
				workflowId: wf.id,
				scriptName: version.deployPath,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return { attempted, failed, ok };
}
