import ts from 'typescript';
import { ctxDtsTemplate } from '$lib/server/wfp/templates.generated';
import { TS_LIB_FILES } from './ts-lib.generated';

// Type-checks an agent-generated workflow source against the project's secret
// Names. Runs in-process on a warm LanguageService + shared DocumentRegistry:
// Lib.*.d.ts parses once per isolate, subsequent checks only re-parse the
// Candidate workflow and (if secrets changed) a tiny synthesized ctx.d.ts.
//
// Diagnostics are formatted for agent consumption — one line per issue,
// `workflow.ts:line:col - error TSxxxx: message` — and fed back through the
// Same emit-retry channel that the regex validators use.

const LIB_DIR = '/lib/';
const CTX_FILENAME = '/ctx.d.ts';
const EVENT_TYPE_FILENAME = '/event-type.d.ts';
const WORKFLOW_FILENAME = '/workflow.ts';
const SECRET_PLACEHOLDER = '/* __RUNELY_SECRET_NAMES__ */ never';
const MAX_REPORTED_DIAGNOSTICS = 20;
const DEFAULT_EVENT_TYPE = `type WorkflowEvent = { body: unknown; headers: { [key: string]: string | undefined } };`;

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
	scripts.set(EVENT_TYPE_FILENAME, { text: DEFAULT_EVENT_TYPE, version: 0 });
	scripts.set(WORKFLOW_FILENAME, { text: '', version: 0 });

	const host: ts.LanguageServiceHost = {
		directoryExists: (dir) => dir === '/' || dir === LIB_DIR.slice(0, -1),
		fileExists: (name) => scripts.has(name),
		getCompilationSettings: () => COMPILER_OPTIONS,
		getCurrentDirectory: () => '/',
		getDefaultLibFileName: () => `${LIB_DIR}lib.es2023.d.ts`,
		getDirectories: () => [],
		getScriptFileNames: () => [CTX_FILENAME, EVENT_TYPE_FILENAME, WORKFLOW_FILENAME],
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

/**
 * Type-check agent-generated workflow source.
 *
 * `secretNames` narrows `ctx.secret` to a union of the project's actual
 * secret names — `ctx.secret("TYPO")` becomes a TS error.
 *
 * `workflowEventTypeTs` is the `type WorkflowEvent = ...` declaration
 * inferred from this workflow's historical events. When provided, it
 * replaces the permissive default so `event.body.foo` accesses validate
 * against the real shape. Pass null/undefined to fall back to the default
 * (used by cron workflows and any other path that doesn't have an inferred
 * type yet).
 */
export function typecheckWorkflow(
	secretNames: readonly string[],
	source: string,
	workflowEventTypeTs?: string | null
): TypecheckResult {
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

	const eventText =
		workflowEventTypeTs && workflowEventTypeTs.trim().length > 0
			? workflowEventTypeTs
			: DEFAULT_EVENT_TYPE;
	const eventScript = scripts.get(EVENT_TYPE_FILENAME);
	if (!eventScript) {
		throw new Error('typecheck: event type script missing');
	}
	if (eventScript.text !== eventText) {
		eventScript.text = eventText;
		eventScript.version += 1;
	}

	const wfScript = scripts.get(WORKFLOW_FILENAME);
	if (!wfScript) {
		throw new Error('typecheck: workflow script missing');
	}
	wfScript.text = source;
	wfScript.version += 1;

	const raw: ts.Diagnostic[] = [
		...service.getSyntacticDiagnostics(WORKFLOW_FILENAME),
		...service.getSemanticDiagnostics(WORKFLOW_FILENAME)
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
					: d.file.fileName === EVENT_TYPE_FILENAME
						? 'event-type.d.ts'
						: d.file.fileName;
		return `${shortName}:${line + 1}:${character + 1} - error TS${d.code}: ${msg}`;
	}
	return `error TS${d.code}: ${msg}`;
}
