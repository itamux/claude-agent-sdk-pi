import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Context, ImageContent, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { mapToolNamePiToSdk } from "./handlers.js";

export function buildPromptBlocks(
	context: Context,
	customToolNameToSdk: Map<string, string> | undefined,
): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];

	const pushText = (text: string) => {
		blocks.push({ type: "text", text });
	};

	const pushImage = (image: ImageContent) => {
		blocks.push({
			type: "image",
			source: {
				type: "base64",
				media_type: image.mimeType as Base64ImageSource["media_type"],
				data: image.data,
			},
		});
	};

	const pushPrefix = (label: string) => {
		const prefix = `${blocks.length ? "\n\n" : ""}${label}\n`;
		pushText(prefix);
	};

	const appendContentBlocks = (
		content:
			| string
			| Array<{
					type: string;
					text?: string;
					data?: string;
					mimeType?: string;
				}>,
	): boolean => {
		if (typeof content === "string") {
			if (content.length > 0) {
				pushText(content);
				return content.trim().length > 0;
			}
			return false;
		}
		if (!Array.isArray(content)) return false;
		let hasText = false;
		for (const block of content) {
			if (block.type === "text") {
				const text = block.text ?? "";
				if (text.trim().length > 0) hasText = true;
				pushText(text);
				continue;
			}
			if (block.type === "image") {
				pushImage(block as ImageContent);
				continue;
			}
			pushText(`[${block.type}]`);
		}
		return hasText;
	};

	for (const message of context.messages) {
		if (message.role === "user") {
			pushPrefix("USER:");
			const hasText = appendContentBlocks(message.content);
			if (!hasText) {
				pushText("(see attached image)");
			}
			continue;
		}

		if (message.role === "assistant") {
			pushPrefix("ASSISTANT:");
			const text = contentToText(message.content, customToolNameToSdk);
			if (text.length > 0) {
				pushText(text);
			}
			continue;
		}

		if (message.role === "toolResult") {
			const toolMsg = message as ToolResultMessage;
			const toolName = mapToolNamePiToSdk(toolMsg.toolName, customToolNameToSdk);
			const isError = toolMsg.isError === true;
			const errorPrefix = isError ? "ERROR: " : "";
			const header = `TOOL RESULT (historical ${toolName}): ${errorPrefix}`;
			pushPrefix(header);
			const hasText = appendContentBlocks(message.content);
			if (!hasText) {
				pushText("(see attached image)");
			}
		}
	}

	if (!blocks.length) return [{ type: "text", text: "" }];

	return blocks;
}

export function buildPromptStream(promptBlocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	async function* generator() {
		const message: SDKUserMessage = {
			type: "user",
			message: {
				role: "user",
				content: promptBlocks,
			} as MessageParam,
			parent_tool_use_id: null,
			session_id: "prompt",
		};

		yield message;
	}

	return generator();
}

function contentToText(
	content: string | Array<TextContent | ThinkingContent | ToolCall | { type: string }>,
	customToolNameToSdk?: Map<string, string>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block.type === "text") return (block as TextContent).text ?? "";
			if (block.type === "thinking") return (block as ThinkingContent).thinking ?? "";
			if (block.type === "toolCall") {
				const tc = block as ToolCall;
				const args = tc.arguments ? JSON.stringify(tc.arguments) : "{}";
				const toolName = mapToolNamePiToSdk(tc.name, customToolNameToSdk);
				return `Historical tool call (non-executable): ${toolName} args=${args}`;
			}
			return `[${block.type}]`;
		})
		.join("\n");
}
