import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { drizzle } from 'drizzle-orm/d1';
import { getRequestEvent } from '$app/server';
import * as schema from './db/auth-schema';
import { createLogger } from './log';
import { EVENTS } from './log-events';
import { errorMessage } from './util';

const log = createLogger('auth');

type Auth = ReturnType<typeof buildAuth>;

const DEFAULT_BASE_URL = 'https://taskcompiler.com';

function buildAuth(env: Env) {
	const db = drizzle(env.DB, { schema });
	const baseURL = env.APP_URL ?? DEFAULT_BASE_URL;

	return betterAuth({
		baseURL,
		secret: env.BETTER_AUTH_SECRET,
		database: drizzleAdapter(db, { provider: 'sqlite', schema }),
		session: {
			expiresIn: 60 * 60 * 24 * 30,
			updateAge: 60 * 60 * 24
		},
		advanced: {
			// Cloudflare forwards the real client IP in CF-Connecting-IP. Telling
			// Better Auth about it enables rate limiting on sign-in endpoints.
			ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] }
		},
		emailAndPassword: { enabled: false },
		socialProviders:
			env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
				? {
						google: {
							clientId: env.GOOGLE_CLIENT_ID,
							clientSecret: env.GOOGLE_CLIENT_SECRET
						}
					}
				: undefined,
		plugins: [
			magicLink({
				sendMagicLink: async ({ email, url }) => {
					await sendMagicLinkEmail(env, email, url);
				}
			}),
			sveltekitCookies(getRequestEvent)
		]
	});
}

async function sendMagicLinkEmail(env: Env, email: string, url: string) {
	// No verified sender domain yet — log the link so auth works end-to-end
	// via `wrangler tail`. Set EMAIL_FROM (e.g. "Runely <auth@yourdomain.com>")
	// once the domain is on Cloudflare DNS and Email Service is enabled.
	// An unset EMAIL_FROM *is* the dev signal here — in prod it will always
	// be set — so we surface the URL-with-token to the unstructured stream
	// only on that branch and never into the structured logger.
	if (!env.EMAIL_FROM) {
		console.log(`[auth] magic link for ${email}: ${url}`);
		return;
	}
	try {
		await env.EMAIL.send({
			from: env.EMAIL_FROM,
			to: email,
			subject: 'Sign in to Runely',
			html: `<p>Click the link below to sign in to Runely. It expires in 5 minutes.</p><p><a href="${url}">${url}</a></p><p>If you didn't request this, ignore this email.</p>`,
			text: `Sign in to Runely: ${url}\n\nThis link expires in 5 minutes. If you didn't request it, ignore this email.`
		});
		log.info(EVENTS.AUTH_MAGIC_LINK_SENT);
	} catch (err) {
		// Fall back to the unstructured stream with the URL so a misconfigured
		// sender domain doesn't lock users out. Also emit a structured warning
		// (without the URL) so on-call sees the failure in the Observability
		// pipeline without the signed token leaking into it.
		console.error(
			`[auth] EMAIL.send failed (${errorMessage(err)}); magic link for ${email}: ${url}`
		);
		log.error(EVENTS.AUTH_EMAIL_SEND_FAILED, { error: errorMessage(err) });
	}
}

// Cache keyed by env identity so per-request env (or test envs) build their own
// Auth instance. In prod the Worker hands out the same env reference for the
// lifetime of the isolate, so the WeakMap behaves like a singleton there.
const cache = new WeakMap<Env, Auth>();

export function auth(env: Env): Auth {
	let instance = cache.get(env);
	if (!instance) {
		instance = buildAuth(env);
		cache.set(env, instance);
	}
	return instance;
}
