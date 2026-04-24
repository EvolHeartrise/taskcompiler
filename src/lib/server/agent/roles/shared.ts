import type { Tool } from '../tools.ts';
import { defineTool } from '../tool-schema.ts';
import { typecheckWorkflow } from '../typecheck/service';

export class EmitSuccess {
	constructor(public readonly payload: unknown) {}
}

export function wrapTerminal<T>(
	tool: Tool,
	controller: AbortController,
	formatMessage: (payload: T) => string
): Tool {
	return {
		...tool,
		async run(input, ctx) {
			try {
				return await tool.run(input, ctx);
			} catch (error) {
				if (error instanceof EmitSuccess) {
					controller.abort();
					return formatMessage(error.payload as T);
				}
				throw error;
			}
		}
	};
}

export interface TypecheckedEmitSpec<Payload> {
	name: string;
	description: string;
	secretNames: readonly string[];
	maxAttempts: number;
	state: { attempts: number; emitted: Payload | null };
	buildPayload(input: { sourceTs: string; summary: string }): Payload;
}

// On failure the agent sees the diagnostics and retries until `maxAttempts`;
// on success the payload is stored on shared state and an EmitSuccess sentinel
// is thrown for `wrapTerminal` to turn into an abort + confirmation message.
export function makeTypecheckedEmitTool<Payload>(spec: TypecheckedEmitSpec<Payload>): Tool {
	return defineTool<{ source_ts: string; summary: string }>({
		name: spec.name,
		description: spec.description,
		fields: {
			source_ts: {
				kind: 'string',
				description:
					'Full TypeScript source of the workflow module. Must export a default async function `run(event, ctx)`.'
			},
			summary: {
				kind: 'string',
				description: 'One-sentence summary of what the workflow does (or the fix applied).'
			}
		},
		required: ['source_ts', 'summary'],
		async run({ source_ts, summary }): Promise<string> {
			spec.state.attempts += 1;
			const tc = typecheckWorkflow(spec.secretNames, source_ts);
			if (!tc.ok) {
				const details = tc.diagnostics.join('\n');
				if (spec.state.attempts >= spec.maxAttempts) {
					throw new Error(
						`TypeScript errors in emitted source (max emit attempts (${spec.maxAttempts}) exhausted):\n${details}`
					);
				}
				throw new Error(
					`TypeScript errors in emitted source. Fix them and call ${spec.name} again:\n${details}`
				);
			}
			spec.state.emitted = spec.buildPayload({ sourceTs: source_ts, summary });
			throw new EmitSuccess(spec.state.emitted);
		}
	});
}
