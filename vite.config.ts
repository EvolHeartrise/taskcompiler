import { sveltekit } from '@sveltejs/kit/vite';
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
	plugins: [sveltekit()]
});
