import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
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
	const allowlist = parseBetaAllowlist(env.BETA_ALLOWLIST);

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
		databaseHooks:
			allowlist === null
				? undefined
				: {
						user: {
							create: {
								before: async (user) => {
									if (await isBetaAllowed(env, allowlist, user.email)) {
										return;
									}
									log.info(EVENTS.AUTH_SIGNUP_BLOCKED, { email: user.email, via: 'create' });
									throw new APIError('FORBIDDEN', {
										message: 'Sign-ups are currently invite-only.'
									});
								}
							}
						}
					},
		plugins: [
			magicLink({
				sendMagicLink: async ({ email, url }) => {
					if (allowlist !== null && !(await isBetaAllowed(env, allowlist, email))) {
						// Silent no-op: returning success without sending avoids turning
						// the form into an enumeration oracle. databaseHooks above is the
						// real security boundary if anyone forges a token from elsewhere.
						log.info(EVENTS.AUTH_SIGNUP_BLOCKED, { email, via: 'magic_link' });
						return;
					}
					await sendMagicLinkEmail(env, email, url);
				}
			}),
			sveltekitCookies(getRequestEvent)
		]
	});
}

// Private-beta gate. Lifecycle:
//   • BETA_ALLOWLIST unset → returns null, gate is off, anyone can sign up.
//   • BETA_ALLOWLIST set (any value, even empty) → returns a Set of normalized
//     emails. Only those + anyone with a pending project_invites row may
//     sign up.
// To open public sign-ups, `wrangler secret delete BETA_ALLOWLIST` and redeploy
// — no code change needed. To remove the gate entirely, drop this helper, the
// `databaseHooks` block, and the `if (allowlist !== null && ...)` branch in
// `sendMagicLink` above.
function parseBetaAllowlist(raw: string | undefined): Set<string> | null {
	if (raw === undefined) {
		return null;
	}
	return new Set(
		raw
			.split(',')
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean)
	);
}

async function isBetaAllowed(env: Env, allowlist: Set<string>, email: string): Promise<boolean> {
	const normalized = email.trim().toLowerCase();
	if (allowlist.has(normalized)) {
		return true;
	}
	// Auto-allow anyone with a live project invite — invites become a second
	// admission path so existing testers can grow the beta without a redeploy.
	const row = await env.DB.prepare(
		`SELECT 1 AS x FROM project_invites
		 WHERE LOWER(email) = ? AND status = 'pending' AND expires_at > ?
		 LIMIT 1`
	)
		.bind(normalized, Date.now())
		.first<{ x: number }>();
	return row !== null;
}

async function sendMagicLinkEmail(env: Env, email: string, url: string) {
	try {
		await env.EMAIL.send({
			from: env.EMAIL_FROM,
			to: email,
			subject: 'Sign in to TaskCompiler',
			html: `<p>Click the link below to sign in to TaskCompiler. It expires in 5 minutes.</p><p><a href="${url}">${url}</a></p><p>If you didn't request this, ignore this email.</p>`,
			text: `Sign in to TaskCompiler: ${url}\n\nThis link expires in 5 minutes. If you didn't request it, ignore this email.`
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
