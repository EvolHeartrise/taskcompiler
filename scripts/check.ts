#!/usr/bin/env bun
// Wrapper around `svelte-check` that normalizes the working directory to its
// on-disk casing before spawning child processes. On Windows, bash (Git Bash /
// MSYS) lower-cases the drive letter and any path component the user typed,
// so `process.cwd()` may not match the canonical filesystem casing
// (e.g. `D:\git\taskcompiler` vs the on-disk `D:\Git\taskcompiler`). When TypeScript /
// tsgo resolves `node_modules/...` imports, some code paths take the
// canonical casing from the OS while others reuse the cwd-derived path,
// triggering bogus `forceConsistentCasingInFileNames` errors on a cold cache.
//
// We fix this once, here, by resolving the cwd via `realpathSync.native`
// (which returns the OS-canonical casing) and chdir-ing into it before we
// spawn the rest of the pipeline. All downstream tools — `svelte-kit sync`
// and `svelte-check` — then see a single consistent casing.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const canonicalCwd = realpathSync.native(process.cwd());
if (canonicalCwd !== process.cwd()) {
	process.chdir(canonicalCwd);
}

const extraArgs = process.argv.slice(2);

function run(cmd: string, args: string[]): void {
	const result = spawnSync(cmd, args, {
		stdio: 'inherit',
		cwd: canonicalCwd,
		shell: process.platform === 'win32'
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

run('bun', ['run', 'scripts/generate-templates.ts']);
run('svelte-kit', ['sync']);
run('svelte-check', ['--tsconfig', './tsconfig.json', '--incremental', '--tsgo', ...extraArgs]);
