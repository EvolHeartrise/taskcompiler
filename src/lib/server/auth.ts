import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { drizzle } from 'drizzle-orm/d1';
import { getRequestEvent } from '$app/server';
import * as schema from './db/auth-schema';
import { getEnv } from './env';

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
	// Without a Resend key we log the link so dev/staging still works end-to-end.
	if (!env.RESEND_API_KEY) {
		console.log(`[auth] magic link for ${email}: ${url}`);
		return;
	}
	const from = env.EMAIL_FROM ?? 'Runely <onboarding@resend.dev>';
	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			from,
			to: email,
			subject: 'Sign in to Runely',
			html: `<p>Click the link below to sign in to Runely. It expires in 5 minutes.</p><p><a href="${url}">${url}</a></p><p>If you didn't request this, ignore this email.</p>`
		})
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`resend send failed: ${res.status} ${body.slice(0, 200)}`);
	}
}

let cached: { env: Env; auth: Auth } | null = null;

export function auth(): Auth {
	const env = getEnv();
	// Memoize per-isolate while bindings are stable. Workers reuse isolates so
	// the identity check keeps us from reconstructing Better Auth every request.
	if (cached && cached.env === env) return cached.auth;
	cached = { env, auth: buildAuth(env) };
	return cached.auth;
}
