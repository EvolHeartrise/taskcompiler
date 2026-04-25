// See https://svelte.dev/docs/kit/types#app.d.ts
import type {
	CfProperties,
	D1Database,
	DispatchNamespace,
	ExecutionContext,
	SendEmail,
	Workflow
} from '@cloudflare/workers-types';
import type { auth } from '$lib/server/auth';
import type { GenWorkflowParams } from '$lib/server/workflows/gen-flow';
import type { HealWorkflowParams } from '$lib/server/workflows/heal-flow';

type AuthSession = NonNullable<Awaited<ReturnType<ReturnType<typeof auth>['api']['getSession']>>>;

declare global {
	namespace App {
		interface Locals {
			user: AuthSession['user'] | null;
			session: AuthSession['session'] | null;
		}
		interface Platform {
			env: Env;
			cf: CfProperties;
			ctx: ExecutionContext;
		}
	}

	// Augment the wrangler-generated Cloudflare.Env with secrets/vars (which
	// `wrangler types` doesn't infer) and workflow payload types (which need
	// the project-local generic params).
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
			DISPATCHER: DispatchNamespace;
			CLOUDFLARE_API_TOKEN: string;
			CLOUDFLARE_ACCOUNT_ID: string;
			CLOUDFLARE_GATEWAY_NAME: string;
			CLOUDFLARE_GATEWAY_TOKEN?: string;
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
}
