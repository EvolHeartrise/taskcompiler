import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolCtx } from '../tools.ts';

interface ReadFileInput {
	path: string;
}

interface WriteFileInput {
	path: string;
	content: string;
}

interface EditFileInput {
	path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

interface BashInput {
	command: string;
	timeout_ms?: number;
}

function resolveSafe(ctx: ToolCtx, rel: string): string {
	if (typeof rel !== 'string' || rel.length === 0) {
		throw new Error('`path` must be a non-empty string');
	}
	const base = path.resolve(ctx.workingDir);
	const full = path.resolve(base, rel);
	if (full !== base && !full.startsWith(base + path.sep)) {
		throw new Error(
			`Path escapes working directory: ${rel} (resolved: ${full}, working dir: ${base})`
		);
	}
	return full;
}

function assertObject(input: unknown, name: string): Record<string, unknown> {
	if (input === null || typeof input !== 'object') {
		throw new Error(`${name} expected an object input`);
	}
	return input as Record<string, unknown>;
}

function requiredString(obj: Record<string, unknown>, key: string, toolName: string): string {
	const v = obj[key];
	if (typeof v !== 'string') {
		throw new TypeError(`${toolName}: missing or non-string field \`${key}\``);
	}
	return v;
}

const readFile: Tool<ReadFileInput, string> = {
	description:
		"Read a UTF-8 text file from the working directory. Input: { path }. Returns the file's contents as a string.",
	inputSchema: {
		additionalProperties: false,
		properties: {
			path: {
				description: 'Path to the file, relative to the working directory.',
				type: 'string'
			}
		},
		required: ['path'],
		type: 'object'
	},
	name: 'read_file',
	async run(input, ctx) {
		const obj = assertObject(input, 'read_file');
		const p = requiredString(obj, 'path', 'read_file');
		const full = resolveSafe(ctx, p);
		return await fs.readFile(full, 'utf8');
	}
};

const writeFile: Tool<WriteFileInput, { bytes: number }> = {
	description:
		'Write (overwrite) a UTF-8 text file in the working directory. Creates parent directories if needed. Input: { path, content }. Returns { bytes }.',
	inputSchema: {
		additionalProperties: false,
		properties: {
			content: {
				description: 'Full file contents to write.',
				type: 'string'
			},
			path: {
				description: 'Path to the file, relative to the working directory.',
				type: 'string'
			}
		},
		required: ['path', 'content'],
		type: 'object'
	},
	name: 'write_file',
	async run(input, ctx) {
		const obj = assertObject(input, 'write_file');
		const p = requiredString(obj, 'path', 'write_file');
		const content = requiredString(obj, 'content', 'write_file');
		const full = resolveSafe(ctx, p);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content, 'utf8');
		return { bytes: Buffer.byteLength(content, 'utf8') };
	}
};

const editFile: Tool<EditFileInput, { replacements: number }> = {
	description:
		'Replace an exact substring in a text file. Input: { path, old_string, new_string, replace_all? }. Fails if `old_string` is absent, or (unless replace_all is true) if it occurs more than once.',
	inputSchema: {
		additionalProperties: false,
		properties: {
			new_string: {
				description: 'Replacement text.',
				type: 'string'
			},
			old_string: {
				description: 'Exact substring to find.',
				type: 'string'
			},
			path: {
				description: 'Path to the file, relative to the working directory.',
				type: 'string'
			},
			replace_all: {
				description:
					'If true, replace every occurrence; otherwise the tool fails when `old_string` is not unique.',
				type: 'boolean'
			}
		},
		required: ['path', 'old_string', 'new_string'],
		type: 'object'
	},
	name: 'edit_file',
	async run(input, ctx) {
		const obj = assertObject(input, 'edit_file');
		const p = requiredString(obj, 'path', 'edit_file');
		const oldStr = requiredString(obj, 'old_string', 'edit_file');
		const newStr = requiredString(obj, 'new_string', 'edit_file');
		const replaceAll = obj.replace_all === true;
		if (oldStr.length === 0) {
			throw new Error('edit_file: `old_string` must be non-empty');
		}
		const full = resolveSafe(ctx, p);
		const contents = await fs.readFile(full, 'utf8');
		const firstIdx = contents.indexOf(oldStr);
		if (firstIdx === -1) {
			throw new Error('edit_file: `old_string` was not found in file');
		}
		let next: string;
		let replacements: number;
		if (replaceAll) {
			const parts = contents.split(oldStr);
			replacements = parts.length - 1;
			next = parts.join(newStr);
		} else {
			const secondIdx = contents.indexOf(oldStr, firstIdx + oldStr.length);
			if (secondIdx !== -1) {
				throw new Error(
					'edit_file: `old_string` occurs more than once; pass replace_all: true or provide a more specific substring'
				);
			}
			next = contents.slice(0, firstIdx) + newStr + contents.slice(firstIdx + oldStr.length);
			replacements = 1;
		}
		await fs.writeFile(full, next, 'utf8');
		return { replacements };
	}
};

interface BashResult {
	stdout: string;
	stderr: string;
	exit_code: number;
	timed_out: boolean;
}

const bash: Tool<BashInput, BashResult> = {
	description:
		'Run a shell command via `bash -lc` in the working directory. Input: { command, timeout_ms? }. Default timeout 60000ms. Returns { stdout, stderr, exit_code, timed_out }.',
	inputSchema: {
		additionalProperties: false,
		properties: {
			command: {
				description: 'Shell command to execute.',
				type: 'string'
			},
			timeout_ms: {
				description:
					'Optional timeout in milliseconds. Default 60000. Process is killed on timeout.',
				type: 'number'
			}
		},
		required: ['command'],
		type: 'object'
	},
	name: 'bash',
	async run(input, ctx) {
		const obj = assertObject(input, 'bash');
		const command = requiredString(obj, 'command', 'bash');
		const timeoutMs =
			typeof obj.timeout_ms === 'number' && obj.timeout_ms > 0 ? obj.timeout_ms : 60000;

		const proc = Bun.spawn(['bash', '-lc', command], {
			cwd: ctx.workingDir,
			stdout: 'pipe',
			stderr: 'pipe'
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {
				// ignore
			}
		}, timeoutMs);

		const onAbort = () => {
			try {
				proc.kill();
			} catch {
				// ignore
			}
		};
		if (ctx.abortSignal) {
			if (ctx.abortSignal.aborted) onAbort();
			else ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
		}

		const [stdoutText, stderrText, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited
		]);
		clearTimeout(timer);
		if (ctx.abortSignal) {
			ctx.abortSignal.removeEventListener('abort', onAbort);
		}

		return {
			stdout: stdoutText,
			stderr: stderrText,
			exit_code: typeof exitCode === 'number' ? exitCode : -1,
			timed_out: timedOut
		};
	}
};

export const defaultTools: Tool[] = [
	readFile as Tool,
	writeFile as Tool,
	editFile as Tool,
	bash as Tool
];
