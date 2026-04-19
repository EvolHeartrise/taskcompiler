import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

function dataDir(): string {
	return resolve(process.env.RUNELY_DATA_DIR ?? "./data");
}

function relativeFor(workflowId: string, version: number): string {
	return join("workflows", workflowId, `v${version}.ts`);
}

export function resolveDeployPath(relative: string): string {
	if (isAbsolute(relative)) return relative;
	return join(dataDir(), relative);
}

export async function writeVersion(
	workflowId: string,
	version: number,
	sourceTs: string,
): Promise<string> {
	const rel = relativeFor(workflowId, version);
	const abs = resolveDeployPath(rel);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, sourceTs, "utf8");
	return rel;
}

export async function readVersionSource(relative: string): Promise<string> {
	const abs = resolveDeployPath(relative);
	return readFile(abs, "utf8");
}

export async function deleteVersion(relative: string): Promise<void> {
	const abs = resolveDeployPath(relative);
	try {
		await unlink(abs);
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code !== "ENOENT") throw err;
	}
}
