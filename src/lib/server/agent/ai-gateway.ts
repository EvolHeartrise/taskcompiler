import { env } from 'cloudflare:workers';
import { truncate } from '$lib/server/util';

// Wire format is Workers AI's OpenAI-compatible chat-completions endpoint,
// routed through AI Gateway for observability. Translation to/from OpenAI
// shape happens inside this module so the loop stays format-agnostic.

export interface TextBlock {
	type: 'text';
	text: string;
}

export interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: unknown;
}

export interface ToolResultBlock {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface AgentMessage {
	role: 'user' | 'assistant';
	content: string | ContentBlock[];
}

export interface AgentTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

export interface MessagesRequest {
	model: string;
	max_tokens: number;
	system?: string;
	messages: AgentMessage[];
	tools?: AgentTool[];
	temperature?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

export interface MessagesResponse {
	content: ContentBlock[];
	stop_reason: StopReason;
	usage: { input_tokens: number; output_tokens: number };
}

interface OAIToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

interface OAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content?: string | null;
	tool_calls?: OAIToolCall[];
	tool_call_id?: string;
}

interface OAITool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface OAIRequest {
	model: string;
	messages: OAIMessage[];
	tools?: OAITool[];
	max_tokens?: number;
	temperature?: number;
}

interface OAIResponse {
	choices: Array<{
		message: {
			role: 'assistant';
			content: string | null;
			tool_calls?: OAIToolCall[];
		};
		finish_reason: string;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toOAIMessages(system: string | undefined, msgs: AgentMessage[]): OAIMessage[] {
	const out: OAIMessage[] = [];
	if (system !== undefined && system.length > 0) {
		out.push({ role: 'system', content: system });
	}
	for (const m of msgs) {
		if (typeof m.content === 'string') {
			out.push({ role: m.role, content: m.content });
			continue;
		}
		if (m.role === 'user') {
			// User turns can mix tool_result blocks (become separate "tool"
			// messages in OpenAI format) with text blocks (collapse to one
			// user message).
			const textParts: string[] = [];
			for (const block of m.content) {
				if (block.type === 'tool_result') {
					out.push({
						role: 'tool',
						tool_call_id: block.tool_use_id,
						content: block.is_error ? `[ERROR] ${block.content}` : block.content
					});
				} else if (block.type === 'text') {
					textParts.push(block.text);
				}
			}
			if (textParts.length > 0) {
				out.push({ role: 'user', content: textParts.join('\n') });
			}
			continue;
		}
		// assistant turn — text + tool_use blocks collapse to one message with
		// optional content and tool_calls array.
		const textParts: string[] = [];
		const toolCalls: OAIToolCall[] = [];
		for (const block of m.content) {
			if (block.type === 'text') {
				textParts.push(block.text);
			} else if (block.type === 'tool_use') {
				toolCalls.push({
					id: block.id,
					type: 'function',
					function: {
						name: block.name,
						arguments: JSON.stringify(block.input ?? {})
					}
				});
			}
		}
		const msg: OAIMessage = { role: 'assistant' };
		msg.content = textParts.length > 0 ? textParts.join('\n') : null;
		if (toolCalls.length > 0) {
			msg.tool_calls = toolCalls;
		}
		out.push(msg);
	}
	return out;
}

function toOAITools(tools: AgentTool[] | undefined): OAITool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map((t) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.input_schema
		}
	}));
}

function parseToolArguments(raw: string): unknown {
	if (!raw || raw.length === 0) {
		return {};
	}
	try {
		return JSON.parse(raw);
	} catch {
		// If the model emitted invalid JSON, surface the raw string so the tool
		// runner rejects it cleanly instead of silently dropping input.
		return { __raw: raw };
	}
}

function fromOAIResponse(resp: OAIResponse): MessagesResponse {
	const choice = resp.choices?.[0];
	if (!choice) {
		throw new Error('Workers AI returned no choices');
	}
	const content: ContentBlock[] = [];
	if (choice.message.content && choice.message.content.length > 0) {
		content.push({ type: 'text', text: choice.message.content });
	}
	for (const tc of choice.message.tool_calls ?? []) {
		content.push({
			type: 'tool_use',
			id: tc.id,
			name: tc.function.name,
			input: parseToolArguments(tc.function.arguments)
		});
	}
	const stop_reason: StopReason =
		choice.finish_reason === 'tool_calls'
			? 'tool_use'
			: choice.finish_reason === 'length'
				? 'max_tokens'
				: 'end_turn';
	return {
		content,
		stop_reason,
		usage: {
			input_tokens: resp.usage?.prompt_tokens ?? 0,
			output_tokens: resp.usage?.completion_tokens ?? 0
		}
	};
}

export async function createMessage(
	body: MessagesRequest,
	opts?: { signal?: AbortSignal }
): Promise<MessagesResponse> {
	const cfToken = env.CLOUDFLARE_API_TOKEN;
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const gatewayName = env.CLOUDFLARE_GATEWAY_NAME;

	const missing: string[] = [];
	if (!cfToken) {
		missing.push('CLOUDFLARE_API_TOKEN');
	}
	if (!accountId) {
		missing.push('CLOUDFLARE_ACCOUNT_ID');
	}
	if (!gatewayName) {
		missing.push('CLOUDFLARE_GATEWAY_NAME');
	}
	if (missing.length > 0) {
		throw new Error(`AI Gateway is misconfigured: missing ${missing.join(', ')} in env bindings.`);
	}

	const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/workers-ai/v1/chat/completions`;

	const oaiBody: OAIRequest = {
		model: body.model,
		messages: toOAIMessages(body.system, body.messages),
		max_tokens: body.max_tokens
	};
	const oaiTools = toOAITools(body.tools);
	if (oaiTools) {
		oaiBody.tools = oaiTools;
	}
	if (body.temperature !== undefined) {
		oaiBody.temperature = body.temperature;
	}

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${cfToken}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify(oaiBody),
		signal: opts?.signal
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(
			`AI Gateway request failed: ${res.status} ${res.statusText}${
				text ? ` — ${truncate(text, 500)}` : ''
			}`
		);
	}

	const parsed = (await res.json()) as OAIResponse;
	return fromOAIResponse(parsed);
}
