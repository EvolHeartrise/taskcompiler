import type { Tool, ToolCtx } from './tools';

// Minimal schema for agent-callable tools. Translates to the JSON Schema
// `input_schema` block the model sees, and to a runtime validator that
// turns model-supplied input into the typed object `run` receives.
//
// Only covers what the agent roles actually use (strings, numbers with
// optional defaults, string enums). Extend here if a future tool needs
// anything richer — don't reach for a full JSON Schema validator unless
// the current vocabulary genuinely isn't enough.

export interface StringField {
	kind: 'string';
	description: string;
}

export interface NumberField {
	kind: 'number';
	description: string;
	default?: number;
}

export interface EnumField<V extends string = string> {
	kind: 'enum';
	description: string;
	values: readonly V[];
}

export type Field = StringField | NumberField | EnumField;

export type FieldMap = Record<string, Field>;

export interface DefineToolSpec<I> {
	name: string;
	description: string;
	fields: FieldMap;
	required?: readonly string[];
	run(input: I, ctx: ToolCtx): Promise<unknown>;
}

function fieldToSchemaProperty(field: Field): Record<string, unknown> {
	if (field.kind === 'string') {
		return { description: field.description, type: 'string' };
	}
	if (field.kind === 'number') {
		return { description: field.description, type: 'number' };
	}
	return {
		description: field.description,
		enum: [...field.values],
		type: 'string'
	};
}

function parseField(
	toolName: string,
	fieldName: string,
	field: Field,
	value: unknown,
	required: boolean
): unknown {
	if (value === undefined || value === null) {
		if (required) {
			throw new Error(`${toolName}: \`${fieldName}\` is required`);
		}
		if (field.kind === 'number' && field.default !== undefined) {
			return field.default;
		}
		return undefined;
	}
	if (field.kind === 'string') {
		if (typeof value !== 'string') {
			throw new TypeError(`${toolName}: \`${fieldName}\` must be a string`);
		}
		return value;
	}
	if (field.kind === 'number') {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new TypeError(`${toolName}: \`${fieldName}\` must be a finite number`);
		}
		return value;
	}
	if (typeof value !== 'string' || !field.values.includes(value)) {
		throw new Error(`${toolName}: \`${fieldName}\` must be one of ${field.values.join(', ')}`);
	}
	return value;
}

export function defineTool<I = Record<string, unknown>>(spec: DefineToolSpec<I>): Tool {
	const properties: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(spec.fields)) {
		properties[key] = fieldToSchemaProperty(field);
	}
	const required = spec.required ?? [];
	const inputSchema: Record<string, unknown> = {
		additionalProperties: false,
		properties,
		type: 'object'
	};
	if (required.length > 0) {
		inputSchema.required = [...required];
	}
	const requiredSet = new Set(required);

	return {
		name: spec.name,
		description: spec.description,
		inputSchema,
		async run(rawInput: unknown, ctx: ToolCtx): Promise<unknown> {
			const obj =
				rawInput !== null && typeof rawInput === 'object'
					? (rawInput as Record<string, unknown>)
					: {};
			const parsed: Record<string, unknown> = {};
			for (const [key, field] of Object.entries(spec.fields)) {
				const value = parseField(spec.name, key, field, obj[key], requiredSet.has(key));
				if (value !== undefined) {
					parsed[key] = value;
				}
			}
			return spec.run(parsed as I, ctx);
		}
	};
}
