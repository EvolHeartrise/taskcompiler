import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { env as cfEnv } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { getRequestEvent } from '$app/server';
import * as schema from './db/auth-schema';
import { errorMessage } from './util';

type Auth = ReturnType<typeof buildAuth>;

const DEFAULT_BASE_URL = 'https://runely.evolheartrise.workers.dev';

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
	} catch (err) {
		// Fall back to console logging so a misconfigured sender domain doesn't
		// lock users out during the beta.
		console.error(
			`[auth] EMAIL.send failed (${errorMessage(err)}); magic link for ${email}: ${url}`
		);
	}
}

let cached: Auth | null = null;

export function auth(): Auth {
	if (!cached) {
		cached = buildAuth(cfEnv);
	}
	return cached;
}
