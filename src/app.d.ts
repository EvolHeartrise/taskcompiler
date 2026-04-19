// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type {
	D1Database,
	CfProperties,
	ExecutionContext,
	DispatchNamespace,
	Workflow
} from '@cloudflare/workers-types';
import type { GenWorkflowParams } from '$lib/server/workflows/gen-flow';
import type { HealWorkflowParams } from '$lib/server/workflows/heal-flow';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: Env;
			cf: CfProperties;
			ctx: ExecutionContext;
		}
	}

	interface Env {
		DB: D1Database;
		DISPATCHER: DispatchNamespace;
		CLOUDFLARE_API_TOKEN: string;
		CLOUDFLARE_ACCOUNT_ID: string;
		CLOUDFLARE_GATEWAY_NAME: string;
		GEN_WORKFLOW: Workflow<GenWorkflowParams>;
		HEAL_WORKFLOW: Workflow<HealWorkflowParams>;
	}
}

export {};
