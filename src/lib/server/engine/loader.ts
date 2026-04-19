import { readVersionSource } from "$lib/server/workflows-store";
import type { WorkflowVersion } from "$lib/server/db/types";
import type { Ctx } from "./context";

export type WorkflowRun = (event: unknown, ctx: Ctx) => Promise<unknown>;

const cache = new Map<string, Promise<WorkflowRun>>();

interface WorkflowModule {
	default?: unknown;
}

function isWorkflowRun(value: unknown): value is WorkflowRun {
	return typeof value === "function";
}

async function loadFromVersion(version: WorkflowVersion): Promise<WorkflowRun> {
	let source: string;
	try {
		source = await readVersionSource(version.deployPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to read workflow source at ${version.deployPath}: ${message}`,
		);
	}

	let js: string;
	try {
		js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to transpile workflow v${version.version}: ${message}`);
	}

	const dataUrl = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

	let mod: WorkflowModule;
	try {
		mod = (await import(dataUrl)) as WorkflowModule;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to import workflow v${version.version}: ${message}`);
	}

	const exported = mod.default;
	if (!isWorkflowRun(exported)) {
		throw new Error(
			`Workflow v${version.version} must export a default async function`,
		);
	}
	return exported;
}

export async function loadWorkflowRun(
	version: WorkflowVersion,
): Promise<WorkflowRun> {
	const cached = cache.get(version.id);
	if (cached) return cached;
	const promise = loadFromVersion(version).catch((err) => {
		cache.delete(version.id);
		throw err;
	});
	cache.set(version.id, promise);
	return promise;
}

export function invalidateVersion(versionId: string): void {
	cache.delete(versionId);
}
