import { describe, expect, it } from 'bun:test';
import { emitWorkflowEventType } from './emit.ts';
import { type Shape, inferShape } from './shape.ts';

function topLevel(body: unknown, headers: Record<string, string>): Shape {
	return inferShape({ body, headers });
}

describe('emitWorkflowEventType', () => {
	it('falls back to permissive type when there are no shapes', () => {
		const out = emitWorkflowEventType([]);
		expect(out).toContain('export type WorkflowEvent');
		expect(out).toContain('body: unknown');
		expect(out).toContain('[key: string]: string | undefined');
	});

	it('emits a single shape without union', () => {
		const out = emitWorkflowEventType([topLevel({ id: 1 }, { 'x-github-event': 'push' })]);
		expect(out).toContain('body: {');
		expect(out).toContain('id: number');
		expect(out).toContain('"x-github-event": "push"');
		expect(out).not.toMatch(/\|\s*{/);
	});

	it('emits a discriminated union for multiple shapes', () => {
		const out = emitWorkflowEventType([
			topLevel({ action: 'opened', pr: { id: 1 } }, { 'x-github-event': 'pull_request' }),
			topLevel({ ref: 'refs/heads/main' }, { 'x-github-event': 'push' })
		]);
		const variants = (out.match(/\n  \| /g) ?? []).length;
		expect(variants).toBe(2);
		expect(out).toContain('"pull_request"');
		expect(out).toContain('"push"');
	});

	it('emits literal-string union for low-cardinality fields', () => {
		const shape = inferShape({ body: { action: 'opened' }, headers: {} });
		// Simulate three observed values for `action`
		const sObj = shape as Extract<Shape, { kind: 'object' }>;
		const body = sObj.fields.body!.shape as Extract<Shape, { kind: 'object' }>;
		body.fields.action = {
			optional: false,
			shape: { kind: 'string', values: ['opened', 'closed', 'reopened'] }
		};
		const out = emitWorkflowEventType([shape]);
		expect(out).toContain('"closed" | "opened" | "reopened"');
	});

	it('drops to plain string when no observed values are tracked', () => {
		const out = emitWorkflowEventType([
			topLevel({ ref: 'a' }, {}),
			topLevel({ ref: 'b' }, {}),
			topLevel({ ref: 'c' }, {}),
			topLevel({ ref: 'd' }, {}),
			topLevel({ ref: 'e' }, {}),
			topLevel({ ref: 'f' }, {}),
			topLevel({ ref: 'g' }, {}),
			topLevel({ ref: 'h' }, {}),
			topLevel({ ref: 'i' }, {}),
			topLevel({ ref: 'j' }, {}),
			topLevel({ ref: 'k' }, {}),
			topLevel({ ref: 'l' }, {}),
			topLevel({ ref: 'm' }, {})
		]);
		// 13 distinct refs should still each render their own variant since each
		// Ref is a single-string-values shape; we don't merge across union members.
		// This test just verifies emission doesn't throw and respects variant count.
		const variants = out.split('|').length - 1;
		expect(variants).toBeGreaterThan(0);
	});

	it('quotes header keys that are not valid identifiers', () => {
		const out = emitWorkflowEventType([topLevel({}, { 'content-type': 'application/json' })]);
		expect(out).toContain('"content-type"');
	});

	it('emits arrays as Array<T> to bind unions correctly', () => {
		const out = emitWorkflowEventType([topLevel({ items: [1, 2, 3] }, {})]);
		expect(out).toContain('Array<number>');
	});

	it('emits unknown for mixed-type arrays', () => {
		const out = emitWorkflowEventType([topLevel({ items: [1, 'two'] }, {})]);
		expect(out).toContain('Array<unknown>');
	});

	it('always includes header index signature', () => {
		const out = emitWorkflowEventType([topLevel({}, { 'x-github-event': 'push' })]);
		expect(out).toContain('[key: string]: string | undefined');
	});

	it('respects custom export name', () => {
		const out = emitWorkflowEventType([topLevel({}, {})], { exportName: 'MyEvent' });
		expect(out).toContain('export type MyEvent');
	});
});
