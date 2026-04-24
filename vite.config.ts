import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The `typescript` compiler (pulled in by src/lib/server/agent/typecheck/service.ts)
// Is CJS and references `__filename`/`__dirname` as lexical identifiers at
// Module-load time to feature-detect its filesystem host. Workers runtime has
// No such globals, so we substitute harmless placeholders at bundle time;
// The code paths that consume them only matter for Node's real fs layer,
// Which we never invoke.
export default defineConfig({
	define: {
		__dirname: '"/"',
		__filename: '"/worker.js"'
	},
	plugins: [sveltekit()],
	// `cloudflare:workers` is a Workers-runtime built-in (stable home of `env`,
	// `WorkflowEntrypoint`, etc.). SvelteKit's post-build `analyse` and
	// `prerender` passes `await import()` the SSR chunks via Node, which
	// doesn't recognise the `cloudflare:` URL scheme and crashes with
	// ERR_UNSUPPORTED_ESM_URL_SCHEME the moment it links a chunk containing
	// this specifier. Alias it to a stub that's safe to load in Node and
	// lazy-forwards to the real module under workerd. See the stub for
	// rationale.
	resolve: {
		alias: {
			'cloudflare:workers': fileURLToPath(
				new URL('./src/lib/server/cloudflare-workers-stub.ts', import.meta.url)
			)
		}
	}
});
