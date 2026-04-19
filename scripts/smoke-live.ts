import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.OPENROUTER_API_KEY) {
	console.error("OPENROUTER_API_KEY not set; skipping live smoke.");
	process.exit(2);
}

process.env.RUNELY_DATA_DIR = mkdtempSync(path.join(tmpdir(), "runely-live-"));

const { generateWorkflow } = await import("../src/lib/server/agent/roles/gen.ts");
const { executeEvent } = await import("../src/lib/server/engine/index.ts");

const dataDir = process.env.RUNELY_DATA_DIR!;
function cleanup() {
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {}
}
process.on("exit", cleanup);

try {
	console.log("Generating workflow via OpenRouter…");
	const gen = await generateWorkflow({
		name: "echo-uppercase",
		prompt:
			"When a webhook arrives with a JSON body containing { message: string }, return an object { upper: string } where upper is the message uppercased. Validate that event.message is a string and throw otherwise.",
		triggerType: "webhook",
		onEvent: (e) => {
			if (e.type === "tool_call") console.log(`  tool_call: ${e.name}`);
			if (e.type === "assistant_message" && e.content.trim())
				console.log(`  assistant: ${e.content.slice(0, 120)}…`);
		},
	});
	console.log("workflowId:", gen.workflowId);
	console.log("versionId:", gen.versionId);
	console.log("---- source ----\n" + gen.sourceTs + "\n----------------");

	const ok = await executeEvent({
		workflowId: gen.workflowId,
		trigger: "webhook",
		payload: { message: "hello runely" },
	});
	console.log("happy run:", ok.status, ok.result);
	if (ok.status !== "ok") {
		console.error("FAILED: happy path should be ok");
		process.exit(1);
	}
	const r = ok.result as { upper?: string };
	if (r?.upper !== "HELLO RUNELY") {
		console.error("FAILED: upper mismatch", r);
		process.exit(1);
	}

	const bad = await executeEvent({
		workflowId: gen.workflowId,
		trigger: "webhook",
		payload: { not: "message" },
	});
	console.log("bad-shape run:", bad.status, bad.error?.message);

	console.log("LIVE_SMOKE_OK");
	cleanup();
	process.exit(0);
} catch (err) {
	console.error("LIVE_SMOKE_FAIL", err);
	cleanup();
	process.exit(1);
}
