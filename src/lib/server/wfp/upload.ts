import { transform } from 'sucrase';
import { env } from 'cloudflare:workers';
import { errorMessage, truncate } from '$lib/server/util';
import {
	COMPATIBILITY_DATE,
	COMPATIBILITY_FLAGS,
	DEFAULT_D1_DATABASE_ID,
	DISPATCH_NAMESPACE
} from './config';

// Pre-inlined into a generated TS module (see scripts/generate-templates.ts).
// Avoiding Vite's `?raw` suffix here lets Wrangler's esbuild — which doesn't
// understand `?raw` — bundle this file with `src/worker.ts` for deployment.
import {
	bootstrapCtxSource,
	bootstrapErrorSource,
	bootstrapMainSource
} from './templates.generated';

export type WfpBinding =
	| { type: 'd1'; name: string; database_id: string }
	| { type: 'plain_text'; name: string; text: string }
	| { type: 'secret_text'; name: string; text: string };

export interface UploadInput {
	scriptName: string;
	userSourceTs: string;
	bindings?: WfpBinding[];
}

export interface UploadResult {
	scriptName: string;
	uploadedAt: number;
}

interface CloudflareErrorEntry {
	code: number;
	message: string;
}

interface CloudflareApiError {
	success: false;
	errors?: CloudflareErrorEntry[];
}

const MODULE_MIME = 'application/javascript+module';
const METADATA_MIME = 'application/json';

function transpile(source: string, label: string): string {
	try {
		return transform(source, { transforms: ['typescript'] }).code;
	} catch (error) {
		throw new Error(`Failed to transpile ${label}: ${errorMessage(error)}`, { cause: error });
	}
}

function requireEnv(): { accountId: string; token: string } {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const token = env.CLOUDFLARE_API_TOKEN;
	const missing: string[] = [];
	if (!accountId) {
		missing.push('CLOUDFLARE_ACCOUNT_ID');
	}
	if (!token) {
		missing.push('CLOUDFLARE_API_TOKEN');
	}
	if (missing.length > 0) {
		throw new Error(`WFP upload misconfigured: missing ${missing.join(', ')} in env bindings.`);
	}
	return { accountId, token };
}

function scriptUrl(accountId: string, scriptName: string): string {
	return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${DISPATCH_NAMESPACE}/scripts/${encodeURIComponent(scriptName)}`;
}

export async function uploadWorkflow(input: UploadInput): Promise<UploadResult> {
	const { accountId, token } = requireEnv();

	const userJs = transpile(input.userSourceTs, 'user workflow');
	const mainJs = transpile(bootstrapMainSource, 'bootstrap main.ts');
	const ctxJs = transpile(bootstrapCtxSource, 'bootstrap ctx.ts');
	const errorJs = transpile(bootstrapErrorSource, 'bootstrap error.ts');

	const bindings: WfpBinding[] = [
		{ database_id: DEFAULT_D1_DATABASE_ID, name: 'DB', type: 'd1' },
		...(input.bindings ?? [])
	];

	const metadata = {
		bindings,
		compatibility_date: COMPATIBILITY_DATE,
		compatibility_flags: [...COMPATIBILITY_FLAGS],
		main_module: 'main.js'
	};

	const fd = new FormData();
	fd.append('metadata', new Blob([JSON.stringify(metadata)], { type: METADATA_MIME }));
	fd.append('main.js', new Blob([mainJs], { type: MODULE_MIME }), 'main.js');
	fd.append('ctx.js', new Blob([ctxJs], { type: MODULE_MIME }), 'ctx.js');
	fd.append('error.js', new Blob([errorJs], { type: MODULE_MIME }), 'error.js');
	fd.append('workflow.js', new Blob([userJs], { type: MODULE_MIME }), 'workflow.js');

	const res = await fetch(scriptUrl(accountId, input.scriptName), {
		body: fd,
		headers: { Authorization: `Bearer ${token}` },
		method: 'PUT'
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(
			`WFP upload failed for ${input.scriptName}: ${res.status} ${res.statusText}${
				text ? ` — ${truncate(text, 500)}` : ''
			}`
		);
	}

	return { scriptName: input.scriptName, uploadedAt: Date.now() };
}

export async function deleteWorkflow(scriptName: string): Promise<void> {
	const { accountId, token } = requireEnv();

	const res = await fetch(scriptUrl(accountId, scriptName), {
		headers: { Authorization: `Bearer ${token}` },
		method: 'DELETE'
	});

	if (res.status === 404) {
		return;
	}
	if (res.ok) {
		return;
	}

	const text = await res.text().catch(() => '');
	let parsed: CloudflareApiError | undefined;
	if (text) {
		try {
			parsed = JSON.parse(text) as CloudflareApiError;
		} catch {
			/* fall through to raw text */
		}
	}
	const detail = parsed?.errors?.length
		? parsed.errors.map((e) => `[${e.code}] ${e.message}`).join('; ')
		: truncate(text, 500);
	throw new Error(
		`WFP delete failed for ${scriptName}: ${res.status} ${res.statusText}${
			detail ? ` — ${detail}` : ''
		}`
	);
}
