// Stub for `cloudflare:workers` — see vite.config.ts for the alias.
//
// Why: the Workers runtime exposes `import { env } from 'cloudflare:workers'`
// natively, but Node (which SvelteKit uses for the post-build `analyse` and
// `prerender` passes) doesn't understand the `cloudflare:` URL scheme and
// crashes with ERR_UNSUPPORTED_ESM_URL_SCHEME the moment it tries to link a
// chunk that statically imports it. So we redirect every `cloudflare:workers`
// import to this file, which:
//
//   1. In workerd, lazy-loads the real module via a string-concatenated
//      dynamic `import()` that bundlers can't statically analyse, so the
//      specifier survives the SSR build verbatim and workerd resolves it
//      against its built-in module registry.
//   2. In Node (analyse / prerender), the dynamic import is never triggered
//      because we gate it on the workerd-only `navigator.userAgent`. Reads
//      against `env` return `undefined`, which is fine: analyse only inspects
//      module export *shapes* and never invokes the functions that touch
//      bindings.

const isWorkerd =
	typeof navigator !== 'undefined' &&
	(navigator as { userAgent?: string }).userAgent === 'Cloudflare-Workers';

let realEnv: Record<string, unknown> = {};

if (isWorkerd) {
	// String-concatenated specifier so Vite's static analysis can't rewrite
	// the import — the literal must reach workerd verbatim for the runtime
	// loader to recognise the `cloudflare:` scheme.
	// oxlint-disable-next-line no-useless-concat
	const specifier = 'cloudflare' + ':workers';
	const mod: { env: Record<string, unknown> } = await import(/* @vite-ignore */ specifier);
	realEnv = mod.env;
}

export const env = realEnv as never;
