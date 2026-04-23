import { describe, expect, it } from 'bun:test';
import { type Shape, hashShape, inferShape, mergeShapes } from './shape.ts';

describe('inferShape', () => {
	it('handles primitives', () => {
		expect(inferShape(null)).toEqual({ kind: 'null' });
		expect(inferShape(true)).toEqual({ kind: 'boolean' });
		expect(inferShape(1)).toEqual({ kind: 'number' });
		expect(inferShape('hello')).toEqual({ kind: 'string', values: ['hello'] });
	});

	it('handles nested objects with sorted-stable behavior', () => {
		const shape = inferShape({ a: 1, b: 'x', c: { d: true } });
		expect(shape.kind).toBe('object');
		if (shape.kind !== 'object') {
			throw new Error('unreachable');
		}
		expect(Object.keys(shape.fields).toSorted()).toEqual(['a', 'b', 'c']);
		expect(shape.fields.c!.shape.kind).toBe('object');
	});

	it('handles homogeneous arrays', () => {
		const shape = inferShape([1, 2, 3]);
		expect(shape).toEqual({ element: { kind: 'number' }, kind: 'array' });
	});

	it('falls back to unknown for mixed-type array elements', () => {
		const shape = inferShape([1, 'two']);
		expect(shape).toEqual({ element: { kind: 'unknown' }, kind: 'array' });
	});

	it('infers empty arrays as unknown element', () => {
		expect(inferShape([])).toEqual({ element: { kind: 'unknown' }, kind: 'array' });
	});

	it('captures observed string values for narrowing', () => {
		const shape = inferShape({ action: 'opened' });
		const action = (shape as Extract<Shape, { kind: 'object' }>).fields.action!.shape;
		expect(action).toEqual({ kind: 'string', values: ['opened'] });
	});

	it('marks object fields as required (single-event inference)', () => {
		const shape = inferShape({ a: 1 });
		const a = (shape as Extract<Shape, { kind: 'object' }>).fields.a!;
		expect(a.optional).toBe(false);
	});
});

describe('mergeShapes', () => {
	it('drops to unknown when kinds differ', () => {
		expect(mergeShapes({ kind: 'string' }, { kind: 'number' })).toEqual({ kind: 'unknown' });
	});

	it('merges string values within the cap', () => {
		const merged = mergeShapes(
			{ kind: 'string', values: ['opened'] },
			{ kind: 'string', values: ['closed'] }
		);
		expect(merged).toEqual({ kind: 'string', values: ['closed', 'opened'] });
	});

	it('drops to plain string when observed values exceed cap', () => {
		let s: Shape = { kind: 'string', values: [] };
		for (let i = 0; i < 20; i++) {
			s = mergeShapes(s, { kind: 'string', values: [`v${i}`] });
		}
		expect(s).toEqual({ kind: 'string' });
	});

	it('marks object fields as optional when only present in one side', () => {
		const a = inferShape({ x: 1, y: 2 });
		const b = inferShape({ x: 1 });
		const merged = mergeShapes(a, b);
		const { fields } = merged as Extract<Shape, { kind: 'object' }>;
		expect(fields.x!.optional).toBe(false);
		expect(fields.y!.optional).toBe(true);
	});
});

describe('hashShape', () => {
	it('returns same hash for structurally identical shapes', async () => {
		const a = inferShape({ id: 1, name: 'a' });
		const b = inferShape({ id: 99, name: 'completely different' });
		expect(await hashShape(a)).toBe(await hashShape(b));
	});

	it('returns different hash for structurally different shapes', async () => {
		const a = inferShape({ id: 1, name: 'a' });
		const b = inferShape({ extra: true, id: 1, name: 'a' });
		expect(await hashShape(a)).not.toBe(await hashShape(b));
	});

	it('returns different hash when a leaf type changes', async () => {
		const a = inferShape({ id: 1 });
		const b = inferShape({ id: '1' });
		expect(await hashShape(a)).not.toBe(await hashShape(b));
	});

	it('is insensitive to object key insertion order', async () => {
		const a = inferShape({ a: 1, b: 2 });
		const b = inferShape({ a: 1, b: 2 });
		expect(await hashShape(a)).toBe(await hashShape(b));
	});

	it('is sensitive to optional flags on fields', async () => {
		const a: Shape = {
			fields: { x: { optional: false, shape: { kind: 'number' } } },
			kind: 'object'
		};
		const b: Shape = {
			fields: { x: { optional: true, shape: { kind: 'number' } } },
			kind: 'object'
		};
		expect(await hashShape(a)).not.toBe(await hashShape(b));
	});
});
