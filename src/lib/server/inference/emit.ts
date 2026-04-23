// TS type emission from inferred Shapes. Pure renderer — no I/O, no awaits.
//
// `emitWorkflowEventType(shapes)` takes the deduplicated set of {body, headers}
// Shapes for a workflow and emits a single `export type WorkflowEvent` union.
// String fields with ≤ 12 observed values render as literal unions, which is
// What makes downstream discriminated-union narrowing work in user code:
//
//   If (event.headers['x-github-event'] === 'pull_request') {
//     // event.body narrowed to the matching variant
//   }

import type { Shape } from './shape.ts';

const MAX_LITERAL_UNION = 12;
const HEADERS_INDEX_SIG = '[key: string]: string | undefined';

const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(name: string): string {
	return VALID_IDENT.test(name) ? name : JSON.stringify(name);
}

interface EmitOptions {
	indent: string;
	indexSignature?: string;
}

function emitShape(shape: Shape, opts: EmitOptions): string {
	switch (shape.kind) {
		case 'null': {
			return 'null';
		}
		case 'boolean': {
			return 'boolean';
		}
		case 'number': {
			return 'number';
		}
		case 'unknown': {
			return 'unknown';
		}
		case 'string': {
			const { values } = shape;
			if (values && values.length > 0 && values.length <= MAX_LITERAL_UNION) {
				return [...values]
					.toSorted()
					.map((v) => JSON.stringify(v))
					.join(' | ');
			}
			return 'string';
		}
		case 'array': {
			const elem = emitShape(shape.element, { indent: opts.indent });
			// Wrap unions to keep array semantics correct (`Array<A | B>` not `(A | B)[]`).
			return `Array<${elem}>`;
		}
		case 'object': {
			const inner = `${opts.indent}  `;
			const keys = Object.keys(shape.fields).toSorted();
			const lines: string[] = [];
			if (opts.indexSignature) {
				lines.push(`${inner}${opts.indexSignature};`);
			}
			for (const k of keys) {
				const f = shape.fields[k]!;
				const opt = f.optional ? '?' : '';
				lines.push(`${inner}${propertyKey(k)}${opt}: ${emitShape(f.shape, { indent: inner })};`);
			}
			if (lines.length === 0) {
				return '{}';
			}
			return `{\n${lines.join('\n')}\n${opts.indent}}`;
		}
	}
}

// Render a top-level {body, headers} shape with the headers field augmented by
// An index signature so user code can safely access unseen header keys.
function emitTopLevelVariant(shape: Shape, indent: string): string {
	if (shape.kind !== 'object') {
		return emitShape(shape, { indent });
	}
	const inner = `${indent}  `;
	const { body } = shape.fields;
	const { headers } = shape.fields;
	const bodyTs = body ? emitShape(body.shape, { indent: inner }) : 'unknown';
	const headersTs = headers
		? emitShape(headers.shape, { indent: inner, indexSignature: HEADERS_INDEX_SIG })
		: `{ ${HEADERS_INDEX_SIG} }`;
	return `{\n${inner}body: ${bodyTs};\n${inner}headers: ${headersTs};\n${indent}}`;
}

export interface EmitWorkflowEventOptions {
	exportName?: string;
}

export function emitWorkflowEventType(
	shapes: Shape[],
	opts: EmitWorkflowEventOptions = {}
): string {
	const name = opts.exportName ?? 'WorkflowEvent';
	if (shapes.length === 0) {
		return `export type ${name} = { body: unknown; headers: { ${HEADERS_INDEX_SIG} } };`;
	}
	if (shapes.length === 1) {
		return `export type ${name} = ${emitTopLevelVariant(shapes[0]!, '')};`;
	}
	const variants = shapes.map((s) => emitTopLevelVariant(s, '  '));
	return `export type ${name} =\n  | ${variants.join('\n  | ')};`;
}
