import { getEnv } from "$lib/server/env";

export interface AnthropicTextBlock {
	type: "text";
	text: string;
}

export interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

export interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

export type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock;

export interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

export interface MessagesRequest {
	model: string;
	max_tokens: number;
	system?: string;
	messages: AnthropicMessage[];
	tools?: AnthropicTool[];
	temperature?: number;
	stream?: false;
}

export interface MessagesResponse {
	id: string;
	type: "message";
	role: "assistant";
	content: AnthropicContentBlock[];
	model: string;
	stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
	stop_sequence: string | null;
	usage: { input_tokens: number; output_tokens: number };
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + `… [+${s.length - max} chars]`;
}

export async function createMessage(
	body: MessagesRequest,
	opts?: { signal?: AbortSignal }
): Promise<MessagesResponse> {
	const env = getEnv();
	const apiKey = env.ANTHROPIC_API_KEY;
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const gatewayName = env.CLOUDFLARE_GATEWAY_NAME;

	const missing: string[] = [];
	if (!apiKey) missing.push("ANTHROPIC_API_KEY");
	if (!accountId) missing.push("CLOUDFLARE_ACCOUNT_ID");
	if (!gatewayName) missing.push("CLOUDFLARE_GATEWAY_NAME");
	if (missing.length > 0) {
		throw new Error(
			`AI Gateway is misconfigured: missing ${missing.join(", ")} in env bindings.`
		);
	}

	const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/v1/messages`;

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json"
		},
		body: JSON.stringify(body),
		signal: opts?.signal
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`AI Gateway request failed: ${res.status} ${res.statusText}${
				text ? ` — ${truncate(text, 500)}` : ""
			}`
		);
	}

	return (await res.json()) as MessagesResponse;
}
