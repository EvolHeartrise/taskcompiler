const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface OpenRouterMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	name?: string;
	tool_call_id?: string;
	tool_calls?: OpenRouterToolCall[];
}

export interface OpenRouterToolFunction {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface OpenRouterTool {
	type: "function";
	function: OpenRouterToolFunction;
}

export interface ChatCompletionChoice {
	index: number;
	message: OpenRouterMessage;
	finish_reason: string | null;
}

export interface ChatCompletionUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}

export interface ChatCompletionResponse {
	id: string;
	model: string;
	choices: ChatCompletionChoice[];
	usage?: ChatCompletionUsage;
}

export interface ChatCompletionRequest {
	model: string;
	messages: OpenRouterMessage[];
	tools?: OpenRouterTool[];
	signal?: AbortSignal;
}

export async function chatCompletion(
	req: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		throw new Error(
			"OPENROUTER_API_KEY is not set. Export it in your environment before calling the agent."
		);
	}

	const body: Record<string, unknown> = {
		model: req.model,
		messages: req.messages
	};
	if (req.tools && req.tools.length > 0) {
		body.tools = req.tools;
		body.tool_choice = "auto";
	}

	const res = await fetch(OPENROUTER_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			"HTTP-Referer": "https://runely.local",
			"X-Title": "Runely"
		},
		body: JSON.stringify(body),
		signal: req.signal
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`OpenRouter request failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`
		);
	}

	return (await res.json()) as ChatCompletionResponse;
}
