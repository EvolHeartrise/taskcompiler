// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { D1Database, CfProperties, ExecutionContext } from '@cloudflare/workers-types';

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
		CLOUDFLARE_API_TOKEN: string;
		CLOUDFLARE_ACCOUNT_ID: string;
		CLOUDFLARE_GATEWAY_NAME: string;
	}
}

export {};
