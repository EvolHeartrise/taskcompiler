// Header redaction for inbound webhooks. Run on every event before persistence.
//
// Strategy (denylist + name-regex + size caps + CF-noise strip):
//   1. Lowercase all header names.
//   2. Drop Cloudflare- and proxy-injected headers entirely (noise + IP leakage).
//   3. For survivors, redact the value to "<redacted>" if the name is a known
//      Auth/signature header — but keep the key so workflow code can branch on
//      Its presence. Specifically targets GitHub `x-hub-signature*`, GitLab
//      `x-gitlab-token`, Stripe `stripe-signature`, Cloudflare `cf-webhook-auth`,
//      Plus any header whose name matches /(signature|hmac|secret|token|auth|
//      Api[-_]?key|webhook[-_]?secret)/i.
//   4. Truncate any single value over 8 KiB.
//   5. Cap to 100 headers and 64 KiB total; stop adding once either trips.

const NAME_DENYLIST = new Set([
	'authorization',
	'proxy-authorization',
	'cookie',
	'set-cookie',
	'x-api-key',
	'x-gitlab-token',
	'cf-webhook-auth',
	'stripe-signature',
	'webhook-signature'
]);

const NAME_REGEX = /(signature|hmac|secret|token|auth|api[-_]?key|webhook[-_]?secret)/i;

const NOISE_EXACT = new Set([
	'cdn-loop',
	'x-real-ip',
	'true-client-ip',
	'x-forwarded-host',
	'x-forwarded-port',
	'x-forwarded-proto'
]);

const REDACTED = '<redacted>';
const TRUNCATED_MARK = '<truncated>';
const MAX_VALUE_BYTES = 8 * 1024;
const MAX_HEADER_COUNT = 100;
const MAX_TOTAL_BYTES = 64 * 1024;

function isNoise(name: string): boolean {
	if (name.startsWith('cf-')) {
		return true;
	}
	if (name.startsWith('x-forwarded-')) {
		return true;
	}
	return NOISE_EXACT.has(name);
}

function shouldRedactValue(name: string): boolean {
	if (NAME_DENYLIST.has(name)) {
		return true;
	}
	return NAME_REGEX.test(name);
}

const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(s: string): number {
	return TEXT_ENCODER.encode(s).length;
}

function truncateValue(value: string): string {
	if (utf8ByteLength(value) <= MAX_VALUE_BYTES) {
		return value;
	}
	// Char-slice approximation; close enough for ASCII-dominant header values.
	return value.slice(0, MAX_VALUE_BYTES - TRUNCATED_MARK.length) + TRUNCATED_MARK;
}

export interface RedactOptions {
	maxHeaders?: number;
	maxTotalBytes?: number;
}

export function redactHeaders(
	input: Headers | Record<string, string>,
	opts: RedactOptions = {}
): Record<string, string> {
	const maxHeaders = opts.maxHeaders ?? MAX_HEADER_COUNT;
	const maxTotal = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
	const entries: [string, string][] =
		input instanceof Headers ? [...input.entries()] : Object.entries(input);

	const out: Record<string, string> = {};
	let totalBytes = 0;
	let count = 0;

	for (const [rawName, rawValue] of entries) {
		if (count >= maxHeaders) {
			break;
		}
		const name = rawName.toLowerCase();
		if (isNoise(name)) {
			continue;
		}

		const value = shouldRedactValue(name) ? REDACTED : truncateValue(rawValue);
		const entryBytes = utf8ByteLength(name) + utf8ByteLength(value);
		if (totalBytes + entryBytes > maxTotal) {
			break;
		}

		out[name] = value;
		totalBytes += entryBytes;
		count += 1;
	}

	return out;
}
