import { describe, expect, it } from 'bun:test';
import { redactHeaders } from './redact.ts';

describe('redactHeaders', () => {
	it('lowercases header names', () => {
		const out = redactHeaders({ 'X-GitHub-Event': 'pull_request' });
		expect(out).toEqual({ 'x-github-event': 'pull_request' });
	});

	it('redacts known auth headers but keeps the key', () => {
		const out = redactHeaders({
			authorization: 'Bearer abc',
			cookie: 'sid=123',
			'stripe-signature': 't=1,v1=abc',
			'x-api-key': 'secret',
			'x-gitlab-token': 'plain-shared-secret'
		});
		expect(out.authorization).toBe('<redacted>');
		expect(out.cookie).toBe('<redacted>');
		expect(out['x-api-key']).toBe('<redacted>');
		expect(out['x-gitlab-token']).toBe('<redacted>');
		expect(out['stripe-signature']).toBe('<redacted>');
	});

	it('redacts custom signature/hmac/token headers via regex', () => {
		const out = redactHeaders({
			'x-acme-token': 't',
			'x-app-secret': 's',
			'x-mycorp-signature': 'sig',
			'x-twilio-hmac': 'hmac',
			'x-webhook-secret': 'w'
		});
		for (const v of Object.values(out)) {
			expect(v).toBe('<redacted>');
		}
	});

	it('drops Cloudflare and proxy noise headers', () => {
		const out = redactHeaders({
			'cdn-loop': 'cloudflare',
			'cf-connecting-ip': '1.2.3.4',
			'cf-ipcountry': 'US',
			'cf-ray': 'abc',
			'true-client-ip': '1.2.3.4',
			'x-forwarded-for': '1.2.3.4',
			'x-forwarded-proto': 'https',
			'x-real-ip': '1.2.3.4'
		});
		expect(Object.keys(out)).toHaveLength(0);
	});

	it('preserves discriminator headers untouched', () => {
		const out = redactHeaders({
			'linear-event': 'Issue',
			'x-github-event': 'pull_request',
			'x-shopify-topic': 'orders/create',
			'x-vercel-event': 'deployment.created'
		});
		expect(out).toEqual({
			'linear-event': 'Issue',
			'x-github-event': 'pull_request',
			'x-shopify-topic': 'orders/create',
			'x-vercel-event': 'deployment.created'
		});
	});

	it('truncates oversized values', () => {
		const big = 'x'.repeat(20_000);
		const out = redactHeaders({ 'x-payload-echo': big });
		const v = out['x-payload-echo']!;
		expect(v.endsWith('<truncated>')).toBe(true);
		expect(v.length).toBeLessThan(big.length);
	});

	it('caps total header count', () => {
		const input: Record<string, string> = {};
		for (let i = 0; i < 200; i++) {
			input[`x-h-${i}`] = String(i);
		}
		const out = redactHeaders(input, { maxHeaders: 10 });
		expect(Object.keys(out)).toHaveLength(10);
	});

	it('caps total bytes', () => {
		const input: Record<string, string> = {};
		for (let i = 0; i < 50; i++) {
			input[`x-h-${i}`] = 'x'.repeat(1000);
		}
		const out = redactHeaders(input, { maxTotalBytes: 5000 });
		const total = Object.entries(out).reduce((n, [k, v]) => n + k.length + v.length, 0);
		expect(total).toBeLessThanOrEqual(5000);
	});

	it('accepts a Headers instance', () => {
		const h = new Headers();
		h.set('X-GitHub-Event', 'push');
		h.set('Authorization', 'Bearer xyz');
		const out = redactHeaders(h);
		expect(out['x-github-event']).toBe('push');
		expect(out.authorization).toBe('<redacted>');
	});
});
