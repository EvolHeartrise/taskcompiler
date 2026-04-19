import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter({
			// Use a separate wrangler config so the adapter writes its Worker
			// to `.svelte-kit/cloudflare/_worker.js` while the real wrangler
			// config (`wrangler.toml`) points `main` at `src/worker.ts` — our
			// wrapper that adds Workflow class exports.
			config: 'wrangler.adapter.toml',
			fallback: 'err'
		})
	}
};

export default config;
