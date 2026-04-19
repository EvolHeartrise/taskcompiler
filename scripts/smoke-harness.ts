import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.RUNELY_DATA_DIR = mkdtempSync(path.join(tmpdir(), "runely-smoke-"));

const { createWorkflow, updateWorkflow } = await import(
	"../src/lib/server/db/queries/workflows.ts"
);
const { createVersion, getCurrentVersion } = await import(
	"../src/lib/server/db/queries/versions.ts"
);
const { listFailedRunsForWorkflow, getRun } = await import(
	"../src/lib/server/db/queries/runs.ts"
);
const { writeVersion } = await import("../src/lib/server/workflows-store/index.ts");
const { executeEvent, replayFailedEvents, invalidateVersion, setRunFailedHook } = await import(
	"../src/lib/server/engine/index.ts"
);

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error("ASSERT: " + msg);
}

const dataDir = process.env.RUNELY_DATA_DIR!;
let cleaned = false;
function cleanup() {
	if (cleaned) return;
	cleaned = true;
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {}
}
process.on("exit", cleanup);

try {
	const wf = createWorkflow({
		name: "smoke",
		prompt: "echo the event",
		triggerType: "webhook",
	});

	const goodSource = `export default async function run(event, ctx) {
  ctx.log("info", "received", event);
  return { echoed: event };
}`;
	const goodPath = await writeVersion(wf.id, 1, goodSource);
	const v1 = createVersion({
		workflowId: wf.id,
		sourceTs: goodSource,
		deployPath: goodPath,
		createdBy: "user",
		setAsCurrent: true,
	});
	assert(v1.version === 1, "v1.version === 1");

	const r1 = await executeEvent({
		workflowId: wf.id,
		trigger: "webhook",
		payload: { hello: "world" },
	});
	assert(r1.status === "ok", `happy-path status should be ok, got ${r1.status}`);
	const result1 = r1.result as { echoed: { hello: string } };
	assert(result1?.echoed?.hello === "world", "result echoed payload");

	let hookFired = false;
	let failedRunId: string | null = null;
	setRunFailedHook((ctx) => {
		hookFired = true;
		failedRunId = ctx.runId;
	});

	const badSource = `export default async function run(event, ctx) {
  ctx.log("info", "about to throw");
  throw new Error("boom");
}`;
	const badPath = await writeVersion(wf.id, 2, badSource);
	const v2 = createVersion({
		workflowId: wf.id,
		sourceTs: badSource,
		deployPath: badPath,
		createdBy: "user",
		setAsCurrent: true,
	});
	updateWorkflow(wf.id, { currentVersionId: v2.id });
	invalidateVersion(v1.id);
	invalidateVersion(v2.id);

	const r2 = await executeEvent({
		workflowId: wf.id,
		trigger: "webhook",
		payload: { willFail: true },
	});
	assert(r2.status === "failed", `broken version should fail, got ${r2.status}`);
	assert(r2.error?.message === "boom", "error.message === 'boom'");
	assert(hookFired, "run-failed hook did not fire");
	assert(failedRunId === r2.runId, "hook got wrong runId");

	const failed = listFailedRunsForWorkflow(wf.id);
	assert(failed.length >= 1, "listFailedRunsForWorkflow should show at least 1");

	const fixedSource = `export default async function run(event, ctx) {
  ctx.log("info", "healed");
  return { healed: true, input: event };
}`;
	const v3Path = await writeVersion(wf.id, 3, fixedSource);
	const v3 = createVersion({
		workflowId: wf.id,
		sourceTs: fixedSource,
		deployPath: v3Path,
		createdBy: "heal",
		parentVersionId: v2.id,
		healedFromRunId: r2.runId,
		setAsCurrent: true,
	});
	invalidateVersion(v2.id);

	const cur = getCurrentVersion(wf.id);
	assert(cur?.id === v3.id, "current version after heal-deploy is v3");

	const replay = await replayFailedEvents(wf.id);
	assert(replay.attempted >= 1, "replay.attempted >= 1");
	assert(replay.ok === replay.attempted, "all replayed events should pass against v3");
	assert(replay.failed === 0, "replay.failed === 0");

	const supersededOld = getRun(r2.runId);
	assert(supersededOld?.status === "superseded", "original failed run marked superseded");

	const stillFailed = listFailedRunsForWorkflow(wf.id);
	assert(
		stillFailed.every((r) => r.isReplay === false && r.status === "failed"),
		"no live-failed runs remaining after replay (only historical ones if any)",
	);

	console.log("HARNESS_SMOKE_OK");
	cleanup();
	process.exit(0);
} catch (err) {
	console.error("HARNESS_SMOKE_FAIL", err);
	cleanup();
	process.exit(1);
}
