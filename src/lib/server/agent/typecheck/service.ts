import ts from 'typescript';
import { ctxDtsTemplate } from '$lib/server/wfp/templates.generated';
import { TS_LIB_FILES } from './ts-lib.generated';

// Warm LanguageService + shared DocumentRegistry: lib.*.d.ts parses once
// per isolate; subsequent checks only re-parse the candidate workflow and
// (if secrets changed) a tiny synthesized ctx.d.ts.

const LIB_DIR = '/lib/';
const CTX_FILENAME = '/ctx.d.ts';
const WORKFLOW_FILENAME = '/workflow.ts';
const MAIN_FILENAME = '/main.ts';
const SECRET_PLACEHOLDER = '/* __TASKCOMPILER_SECRET_NAMES__ */ never';
const MAX_REPORTED_DIAGNOSTICS = 20;

// Forces the workflow's default export through the Ctx-typed signature
// the bootstrap uses at runtime, so a missing default (TS1192/TS2613) or
// wrong signature surfaces as a normal diagnostic without a regex pre-check.
const MAIN_SOURCE = `import workflow from './workflow';
const _check: (event: unknown, ctx: Ctx) => Promise<unknown> = workflow;
void _check;
`;

const COMPILER_OPTIONS: ts.CompilerOptions = {
	allowSyntheticDefaultImports: true,
	esModuleInterop: true,
	isolatedModules: true,
	lib: ['lib.es2023.d.ts', 'lib.webworker.d.ts'],
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	noEmit: true,
	skipLibCheck: true,
	strict: true,
	target: ts.ScriptTarget.ES2022
};

interface Script {
	version: number;
	text: string;
}

interface ServiceState {
	service: ts.LanguageService;
	scripts: Map<string, Script>;
}

let state: ServiceState | null = null;

function init(): ServiceState {
	if (state) {
		return state;
	}

	const scripts = new Map<string, Script>();
	for (const [name, text] of Object.entries(TS_LIB_FILES)) {
		scripts.set(LIB_DIR + name, { text, version: 0 });
	}
	scripts.set(CTX_FILENAME, { text: renderCtxDts([]), version: 0 });
	scripts.set(WORKFLOW_FILENAME, { text: '', version: 0 });
	scripts.set(MAIN_FILENAME, { text: MAIN_SOURCE, version: 0 });

	const host: ts.LanguageServiceHost = {
		directoryExists: (dir) => dir === '/' || dir === LIB_DIR.slice(0, -1),
		fileExists: (name) => scripts.has(name),
		getCompilationSettings: () => COMPILER_OPTIONS,
		getCurrentDirectory: () => '/',
		getDefaultLibFileName: () => `${LIB_DIR}lib.es2023.d.ts`,
		getDirectories: () => [],
		getScriptFileNames: () => [CTX_FILENAME, WORKFLOW_FILENAME, MAIN_FILENAME],
		getScriptSnapshot: (name) => {
			const s = scripts.get(name);
			return s ? ts.ScriptSnapshot.fromString(s.text) : undefined;
		},
		getScriptVersion: (name) => String(scripts.get(name)?.version ?? 0),
		readFile: (name) => scripts.get(name)?.text
	};

	const registry = ts.createDocumentRegistry();
	const service = ts.createLanguageService(host, registry);
	state = { scripts, service };
	return state;
}

function renderCtxDts(secretNames: string[]): string {
	const union = secretNames.length === 0 ? 'never' : secretNames.map((n) => `'${n}'`).join(' | ');
	return ctxDtsTemplate.replace(SECRET_PLACEHOLDER, union);
}

export interface TypecheckResult {
	ok: boolean;
	diagnostics: string[];
}

// `ctx.secret`'s parameter is narrowed to a union of `secretNames` literals
// (or `never` when empty), so `ctx.secret("TYPO")` surfaces as a TS error
// that lists the valid names.
export function typecheckWorkflow(secretNames: readonly string[], source: string): TypecheckResult {
	const { service, scripts } = init();

	const ctxText = renderCtxDts([...secretNames].toSorted());
	const ctxScript = scripts.get(CTX_FILENAME);
	if (!ctxScript) {
		throw new Error('typecheck: ctx script missing');
	}
	if (ctxScript.text !== ctxText) {
		ctxScript.text = ctxText;
		ctxScript.version += 1;
	}

	const wfScript = scripts.get(WORKFLOW_FILENAME);
	if (!wfScript) {
		throw new Error('typecheck: workflow script missing');
	}
	wfScript.text = source;
	wfScript.version += 1;

	const raw: ts.Diagnostic[] = [
		...service.getSyntacticDiagnostics(WORKFLOW_FILENAME),
		...service.getSemanticDiagnostics(WORKFLOW_FILENAME),
		...service.getSyntacticDiagnostics(MAIN_FILENAME),
		...service.getSemanticDiagnostics(MAIN_FILENAME)
	];

	if (raw.length === 0) {
		return { diagnostics: [], ok: true };
	}

	const formatted = raw.slice(0, MAX_REPORTED_DIAGNOSTICS).map((d) => formatDiagnostic(d));
	if (raw.length > MAX_REPORTED_DIAGNOSTICS) {
		formatted.push(`… and ${raw.length - MAX_REPORTED_DIAGNOSTICS} more diagnostics (suppressed)`);
	}
	return { diagnostics: formatted, ok: false };
}

function formatDiagnostic(d: ts.Diagnostic): string {
	const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
	if (d.file && typeof d.start === 'number') {
		const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
		const shortName =
			d.file.fileName === WORKFLOW_FILENAME
				? 'workflow.ts'
				: d.file.fileName === CTX_FILENAME
					? 'ctx.d.ts'
					: d.file.fileName === MAIN_FILENAME
						? 'workflow.ts (default export)'
						: d.file.fileName;
		return `${shortName}:${line + 1}:${character + 1} - error TS${d.code}: ${msg}`;
	}
	return `error TS${d.code}: ${msg}`;
}
