import { describe, expect, it } from 'bun:test';
import { redact } from './log.ts';

describe('redact', () => {
	it('returns primitives unchanged', () => {
		expect(redact(null)).toBe(null);
		expect(redact(42)).toBe(42);
		expect(redact('hello')).toBe('hello');
		expect(redact(undefined)).toBe(undefined);
	});

	it('masks values under secret-matching keys', () => {
		const out = redact({
			api_key: 'sk-live-xxx',
			apiKey: 'sk-live-yyy',
			token: 'ghp_zzz',
			CLOUDFLARE_API_TOKEN: 'xxx',
			BETTER_AUTH_SECRET: 'yyy',
			password: 'hunter2',
			authorization: 'Bearer abc',
			magic_link: 'https://runely/auth?token=zzz'
		});
		expect(out).toEqual({
			api_key: '<redacted>',
			apiKey: '<redacted>',
			token: '<redacted>',
			CLOUDFLARE_API_TOKEN: '<redacted>',
			BETTER_AUTH_SECRET: '<redacted>',
			password: '<redacted>',
			authorization: '<redacted>',
			magic_link: '<redacted>'
		});
	});

	it('keeps allowlisted identifier keys even though they match *_id', () => {
		const out = redact({
			request_id: 'req-1',
			run_id: 'run-1',
			workflow_id: 'wf-1',
			heal_session_id: 'heal-1',
			tick_id: 'tick-1'
		});
		expect(out).toEqual({
			request_id: 'req-1',
			run_id: 'run-1',
			workflow_id: 'wf-1',
			heal_session_id: 'heal-1',
			tick_id: 'tick-1'
		});
	});

	it('walks nested objects and arrays', () => {
		const out = redact({
			outer: {
				inner: { secret: 'no' },
				list: [{ token: 'no' }, { ok: true }]
			}
		});
		expect(out).toEqual({
			outer: {
				inner: { secret: '<redacted>' },
				list: [{ token: '<redacted>' }, { ok: true }]
			}
		});
	});
});
