// See https://svelte.dev/docs/kit/types#app.d.ts
import type {
	CfProperties,
	D1Database,
	DispatchNamespace,
	ExecutionContext,
	SendEmail,
	Workflow
} from '@cloudflare/workers-types';
import type { GenWorkflowParams } from '$lib/server/workflows/gen-flow';
import type { HealWorkflowParams } from '$lib/server/workflows/heal-flow';

declare global {
	namespace App {
		interface Locals {
			user: { id: string; email: string; name: string; image: string | null } | null;
			session: { id: string; token: string; expiresAt: Date; userId: string } | null;
		}
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
		EMAIL: SendEmail;
		BETTER_AUTH_SECRET: string;
		APP_URL?: string;
		GOOGLE_CLIENT_ID?: string;
		GOOGLE_CLIENT_SECRET?: string;
		EMAIL_FROM?: string;
	}
}
