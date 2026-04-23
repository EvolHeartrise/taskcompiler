// Structural shape inference + hashing for webhook payloads.
//
// `inferShape(value)` walks a JSON value and produces a Shape AST. Each event's
// {body, headers} pair is reduced to one Shape, hashed, and deduplicated in the
// Event_shapes table. At type-emission time, all stored shapes for a workflow
// Are unioned into the WorkflowEvent type.
//
// `hashShape(shape)` is purely structural — it ignores observed string values
// (which are emission-time metadata for literal-union narrowing). Two events
// Whose payloads differ only in field values produce the same hash.

export type Shape =
	| { kind: 'null' }
	| { kind: 'boolean' }
	| { kind: 'number' }
	| { kind: 'string'; values?: string[] }
	| { kind: 'array'; element: Shape }
	| { kind: 'object'; fields: Record<string, { shape: Shape; optional: boolean }> }
	| { kind: 'unknown' };

const MAX_OBSERVED_VALUES = 12;

export function inferShape(value: unknown): Shape {
	if (value === null || value === undefined) {
		return { kind: 'null' };
	}
	if (typeof value === 'boolean') {
		return { kind: 'boolean' };
	}
	if (typeof value === 'number') {
		return { kind: 'number' };
	}
	if (typeof value === 'string') {
		return { kind: 'string', values: [value] };
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return { kind: 'array', element: { kind: 'unknown' } };
		}
		let element: Shape = inferShape(value[0]);
		for (let i = 1; i < value.length; i++) {
			element = mergeShapes(element, inferShape(value[i]));
		}
		return { element, kind: 'array' };
	}
	if (typeof value === 'object') {
		const fields: Record<string, { shape: Shape; optional: boolean }> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			fields[k] = { optional: false, shape: inferShape(v) };
		}
		return { fields, kind: 'object' };
	}
	return { kind: 'unknown' };
}

// Merge two shapes into one. Used internally for arrays with mixed-type
// Elements and for combining object field shapes when keys overlap.
export function mergeShapes(a: Shape, b: Shape): Shape {
	if (a.kind === 'unknown') {
		return b;
	}
	if (b.kind === 'unknown') {
		return a;
	}
	if (a.kind !== b.kind) {
		return { kind: 'unknown' };
	}
	if (a.kind === 'null' || a.kind === 'boolean' || a.kind === 'number') {
		return a;
	}
	if (a.kind === 'string' && b.kind === 'string') {
		// Once either side has dropped to plain string (no values tracked),
		// The merged shape stays plain — never re-collect values.
		if (!a.values || !b.values) {
			return { kind: 'string' };
		}
		const merged = new Set([...a.values, ...b.values]);
		if (merged.size > MAX_OBSERVED_VALUES) {
			return { kind: 'string' };
		}
		return { kind: 'string', values: [...merged].toSorted() };
	}
	if (a.kind === 'array' && b.kind === 'array') {
		return { element: mergeShapes(a.element, b.element), kind: 'array' };
	}
	if (a.kind === 'object' && b.kind === 'object') {
		const fields: Record<string, { shape: Shape; optional: boolean }> = {};
		const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
		for (const k of keys) {
			const af = a.fields[k];
			const bf = b.fields[k];
			if (af && bf) {
				fields[k] = {
					optional: af.optional || bf.optional,
					shape: mergeShapes(af.shape, bf.shape)
				};
			} else {
				fields[k] = { optional: true, shape: (af ?? bf)!.shape };
			}
		}
		return { fields, kind: 'object' };
	}
	return { kind: 'unknown' };
}

// Canonical form used for hashing: drop string `values` (emission metadata)
// But keep optional flags (they're structurally meaningful).
function canonicalize(shape: Shape): unknown {
	switch (shape.kind) {
		case 'null':
		case 'boolean':
		case 'number':
		case 'string':
		case 'unknown': {
			return [shape.kind];
		}
		case 'array': {
			return ['array', canonicalize(shape.element)];
		}
		case 'object': {
			const entries = Object.entries(shape.fields).toSorted(([a], [b]) =>
				a < b ? -1 : a > b ? 1 : 0
			);
			return ['object', entries.map(([k, f]) => [k, f.optional, canonicalize(f.shape)])];
		}
	}
}

export async function hashShape(shape: Shape): Promise<string> {
	const json = JSON.stringify(canonicalize(shape));
	const data = new TextEncoder().encode(json);
	const buf = await crypto.subtle.digest('SHA-256', data);
	const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
	// 64-bit prefix: 2^-32 collision odds in a 500-shape per-workflow space.
	return hex.slice(0, 16);
}

export function shapeToJson(shape: Shape): string {
	return JSON.stringify(shape);
}

export function shapeFromJson(json: string): Shape {
	return JSON.parse(json) as Shape;
}
