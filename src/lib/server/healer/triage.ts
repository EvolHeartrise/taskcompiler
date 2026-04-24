// Pre-computed diagnostic block pasted into the heal agent's turn-1 user
// message. Classifying the error and surfacing payload-shape variance up
// front saves the agent from re-deriving things it would otherwise burn
// tool calls on. Pure (no I/O) — orchestrator supplies the inputs.

import { truncate } from '$lib/server/util';
import type { Event, RunError } from '$lib/server/db/types';

export interface TriageInputs {
	triggeringError: RunError | null;
	failedEvent: Event | null;
	currentSource: string;
	historicalEvents: readonly Event[];
}

interface PatternRule {
	re: RegExp;
	tag: string | ((m: RegExpMatchArray) => string);
}

// Ordered: first match wins. Keep the list short and curated — the tag is
// a hint, not a decision, so don't over-specialize. Noisy patterns are
// worse than `uncategorized`.
const PATTERNS: readonly PatternRule[] = [
	{ re: /discord.*4\d\d.*empty message/i, tag: 'discord_400_empty_content' },
	{ re: /secret ['"]([^'"]+)['"] (?:not set|missing)/i, tag: (m) => `secret_missing:${m[1]}` },
	{ re: /Cannot read (?:property|properties) of (?:undefined|null)/, tag: 'null_access' },
	{ re: /fetch failed|network error|ENOTFOUND/i, tag: 'network_failure' },
	{ re: /JSON(?:\.parse)?.*?(?:unexpected|invalid)/i, tag: 'json_parse_error' },
	{ re: /status (5\d\d)/, tag: (m) => `http_5xx:${m[1]}` },
	{ re: /status (4\d\d)/, tag: (m) => `http_4xx:${m[1]}` }
];

export function classifyError(err: RunError | null): string {
	if (!err) {
		return 'uncategorized';
	}
	const haystack = `${err.name}: ${err.message}\n${err.stack ?? ''}`;
	for (const rule of PATTERNS) {
		const m = haystack.match(rule.re);
		if (m) {
			return typeof rule.tag === 'function' ? rule.tag(m) : rule.tag;
		}
	}
	return 'uncategorized';
}

interface StackFrame {
	line: number;
	column: number | null;
	file: string;
}

// V8-style frames: `    at <fn> (<file>:<line>:<col>)` or `    at <file>:<line>:<col>`.
// We only need line/col from the topmost frame that has them.
export function parseTopFrame(stack: string | undefined): StackFrame | null {
	if (!stack) {
		return null;
	}
	const lines = stack.split('\n');
	const re = /at\s+(?:.*?\()?([^\s()]+):(\d+):(\d+)\)?$/;
	for (const raw of lines) {
		const m = raw.trim().match(re);
		if (m) {
			return {
				column: Number.parseInt(m[3]!, 10),
				file: m[1]!,
				line: Number.parseInt(m[2]!, 10)
			};
		}
	}
	return null;
}

function sourceContext(source: string, line: number, window = 5): string {
	const allLines = source.split('\n');
	const lo = Math.max(1, line - window);
	const hi = Math.min(allLines.length, line + window);
	const gutter: string[] = [];
	for (let i = lo; i <= hi; i++) {
		const marker = i === line ? '> ' : '  ';
		gutter.push(`${marker}${String(i).padStart(4)}| ${allLines[i - 1] ?? ''}`);
	}
	return gutter.join('\n');
}

function topLevelKeys(payload: unknown): string[] {
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
		return [];
	}
	return Object.keys(payload as Record<string, unknown>);
}

function shapeKey(keys: string[]): string {
	return keys.toSorted().join(',');
}

interface CanaryEvent {
	id: string;
	keys: string[];
	preview: string;
}

// Group historical events by top-level-key shape and return up to `max`
// representatives (newest within each shape wins). Excludes the shape of
// the failing event to maximise variance in what the agent sees.
export function pickCanaries(
	historicalEvents: readonly Event[],
	excludeShape: string,
	max = 3
): CanaryEvent[] {
	const bucketsBySize = new Map<string, Event>();
	for (const e of historicalEvents) {
		const keys = topLevelKeys(e.payload);
		const shape = shapeKey(keys);
		if (shape === excludeShape) {
			continue;
		}
		const existing = bucketsBySize.get(shape);
		if (!existing || existing.receivedAt < e.receivedAt) {
			bucketsBySize.set(shape, e);
		}
	}
	const picked = Array.from(bucketsBySize.values())
		.toSorted((a, b) => b.receivedAt - a.receivedAt)
		.slice(0, max);
	return picked.map((e) => ({
		id: e.id,
		keys: topLevelKeys(e.payload),
		preview: previewJson(e.payload, 200)
	}));
}

function previewJson(value: unknown, max: number): string {
	let str: string;
	try {
		str = JSON.stringify(value);
	} catch {
		str = String(value);
	}
	return truncate(str, max);
}

export function buildTriageBlock(inputs: TriageInputs): string {
	const parts: string[] = [];
	parts.push('## TRIAGE (pre-computed — skim before calling any tools)');
	parts.push('');

	const tag = classifyError(inputs.triggeringError);
	parts.push(`error_tag: ${tag}`);

	if (inputs.triggeringError) {
		const frame = parseTopFrame(inputs.triggeringError.stack);
		if (frame) {
			parts.push(`top_frame: ${frame.file}:${frame.line}:${frame.column ?? '?'}`);
			parts.push('source_context (±5 lines around the failing line):');
			parts.push('```ts');
			parts.push(sourceContext(inputs.currentSource, frame.line));
			parts.push('```');
		}
	}

	const failedKeys = topLevelKeys(inputs.failedEvent?.payload ?? null);
	if (inputs.failedEvent) {
		parts.push(`failed_event_top_level_keys: [${failedKeys.join(', ')}]`);
	}

	const canaries = pickCanaries(inputs.historicalEvents, shapeKey(failedKeys));
	if (canaries.length > 0) {
		parts.push('');
		parts.push('canary_historical_events (distinct payload shapes, for variance):');
		for (const c of canaries) {
			parts.push(`- id=${c.id} keys=[${c.keys.join(', ')}] preview=${c.preview}`);
		}
	}

	parts.push('');
	return parts.join('\n');
}
