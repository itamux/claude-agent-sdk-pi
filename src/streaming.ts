import { query, type SDKPartialAssistantMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { calculateCost, createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@mariozechner/pi-ai";

import { DEFAULT_TOOLS, mapToolNameSdkToPi, TOOL_EXECUTION_DENIED_MESSAGE, translateToolArgs } from "./handlers.js";
import { buildCustomToolServers, resolveSdkTools } from "./mcp.js";
import { buildPromptBlocks, buildPromptStream } from "./prompt.js";
import { buildTranslationContext, extractAgentsAppend, extractSkillsAppend, loadProviderSettings } from "./settings.js";

// --- Thinking budget constants ---

type ThinkingLevel = NonNullable<SimpleStreamOptions["reasoning"]>;
type NonXhighThinkingLevel = Exclude<ThinkingLevel, "xhigh">;

const DEFAULT_THINKING_BUDGETS: Record<NonXhighThinkingLevel, number> = {
	minimal: 2048,
	low: 8192,
	medium: 16384,
	high: 31999,
};

// NOTE: "xhigh" is unavailable in the TUI because pi-ai's supportsXhigh()
// doesn't recognize the "claude-agent-sdk" api type. As a workaround, opus-4-6
// gets shifted budgets so "high" uses the budget that xhigh would normally use.
const OPUS_46_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
	minimal: 2048,
	low: 8192,
	medium: 31999,
	high: 63999,
	xhigh: 63999,
};

function mapThinkingTokens(
	reasoning?: ThinkingLevel,
	modelId?: string,
	thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"],
): number | undefined {
	if (!reasoning) return undefined;

	const isOpus46 = modelId?.includes("opus-4-6") || modelId?.includes("opus-4.6");
	if (isOpus46) {
		return OPUS_46_THINKING_BUDGETS[reasoning];
	}

	const effectiveReasoning: NonXhighThinkingLevel = reasoning === "xhigh" ? "high" : reasoning;

	const customBudget = thinkingBudgets?.[effectiveReasoning];
	if (typeof customBudget === "number" && Number.isFinite(customBudget) && customBudget > 0) {
		return customBudget;
	}

	return DEFAULT_THINKING_BUDGETS[effectiveReasoning];
}

// --- Helpers ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "end_turn":
		default:
			return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try {
		return JSON.parse(input);
	} catch {
		return fallback;
	}
}

// --- Caching for per-turn rebuilt objects ---

let cachedToolsRef: Tool[] | undefined;
let cachedToolResolution: ReturnType<typeof resolveSdkTools> | undefined;
let cachedCustomToolsRef: Tool[] | undefined;
let cachedMcpServers: ReturnType<typeof buildCustomToolServers>;

function resolveToolsCached(context: Context) {
	if (context.tools === cachedToolsRef && cachedToolResolution) {
		return cachedToolResolution;
	}
	cachedToolsRef = context.tools;
	cachedToolResolution = resolveSdkTools(context);
	return cachedToolResolution;
}

function buildMcpServersCached(customTools: Tool[]) {
	if (customTools === cachedCustomToolsRef) {
		return cachedMcpServers;
	}
	cachedCustomToolsRef = customTools;
	cachedMcpServers = buildCustomToolServers(customTools);
	return cachedMcpServers;
}

// --- Streaming block tracking ---

// Separate tracking state from output content blocks to avoid `delete (block as any)` casts.
// The output blocks go to pi-ai; the tracking map holds transient streaming state.
interface BlockTracker {
	partialJson: string;  // accumulated JSON for toolCall blocks
}

// --- Main streaming function ---

// Model<string> because the pi framework calls with Model<"claude-agent-sdk">
export function streamClaudeAgentSdk(model: Model<string>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let sdkQuery: ReturnType<typeof query> | undefined;
		let wasAborted = false;
		const requestAbort = () => {
			if (!sdkQuery) return;
			void sdkQuery.interrupt().catch(() => {
				try {
					sdkQuery?.close();
				} catch {
					// ignore shutdown errors
				}
			});
		};
		const onAbort = () => {
			wasAborted = true;
			requestAbort();
		};
		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		type TextBlock = { type: "text"; text: string };
		type ThinkingBlock = { type: "thinking"; thinking: string; thinkingSignature?: string };
		type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
		type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

		const blocks = output.content as ContentBlock[];

		// Map from event.index -> blocks array index for O(1) lookup
		const blockIndexMap = new Map<number, number>();
		// Separate tracking state (partialJson) so we don't need to delete it from output blocks
		const blockTrackers = new Map<number, BlockTracker>();

		let started = false;
		let sawStreamEvent = false;
		let sawToolCall = false;
		let shouldStopEarly = false;

		try {
			const { sdkTools, customTools, customToolNameToSdk, customToolNameToPi } = resolveToolsCached(context);
			const promptBlocks = buildPromptBlocks(context, customToolNameToSdk);
			const prompt = buildPromptStream(promptBlocks);

			// pi may pass cwd via options; fall back to process.cwd()
			const cwd = (options as SimpleStreamOptions & { cwd?: string } | undefined)?.cwd ?? process.cwd();

			const mcpServers = buildMcpServersCached(customTools);
			const providerSettings = loadProviderSettings();
			const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
			const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
			const skillsAppend = appendSystemPrompt ? extractSkillsAppend(context.systemPrompt) : undefined;

			// Clarify which tools are actually available, since the claude_code preset
			// system prompt references tools (WebSearch, WebFetch, Agent, etc.) that
			// are not enabled in this bridge.
			const availableToolNames = sdkTools.length > 0 ? sdkTools : [...DEFAULT_TOOLS];
			const customToolNames = customTools.map((t) => t.name);
			const allToolNames = [...availableToolNames, ...customToolNames];
			const toolClarification = `\n\nIMPORTANT: In this environment, only the following tools are available: ${allToolNames.join(", ")}. Do not attempt to use tools not listed here. The parameters "replace_all" (Edit), "pages" (Read), "run_in_background" (Bash), "output_mode"/"type"/"multiline"/"-B"/"-A"/"-n"/"offset" (Grep) are not supported in this environment.`;

			const appendParts = [agentsAppend, skillsAppend, toolClarification].filter((part): part is string => Boolean(part));
			const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
			const allowSkillAliasRewrite = Boolean(skillsAppend);

			const translationCtx = buildTranslationContext(allowSkillAliasRewrite);

			const settingSources: SettingSource[] | undefined = appendSystemPrompt
				? undefined
				: providerSettings.settingSources ?? ["user", "project"];

			const strictMcpConfigEnabled = !appendSystemPrompt && providerSettings.strictMcpConfig !== false;
			const extraArgs = strictMcpConfigEnabled ? { "strict-mcp-config": null } : undefined;

			const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
				cwd,
				tools: sdkTools,
				permissionMode: "dontAsk",
				persistSession: false,
				includePartialMessages: true,
				canUseTool: async () => ({
					behavior: "deny",
					message: TOOL_EXECUTION_DENIED_MESSAGE,
				}),
				systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend ? systemPromptAppend : undefined },
				...(settingSources ? { settingSources } : {}),
				...(extraArgs ? { extraArgs } : {}),
				...(mcpServers ? { mcpServers } : {}),
			};

			const maxThinkingTokens = mapThinkingTokens(options?.reasoning, model.id, options?.thinkingBudgets);
			if (maxThinkingTokens != null) {
				queryOptions.maxThinkingTokens = maxThinkingTokens;
			}

			sdkQuery = query({
				prompt,
				options: queryOptions,
			});

			if (wasAborted) {
				requestAbort();
			}

			for await (const message of sdkQuery) {
				if (!started) {
					stream.push({ type: "start", partial: output });
					started = true;
				}

				switch (message.type) {
					case "stream_event": {
						sawStreamEvent = true;
						const { event } = message as SDKPartialAssistantMessage;

						if (event?.type === "message_start") {
							const usage = event.message?.usage;
							output.usage.input = usage?.input_tokens ?? 0;
							output.usage.output = usage?.output_tokens ?? 0;
							output.usage.cacheRead = usage?.cache_read_input_tokens ?? 0;
							output.usage.cacheWrite = usage?.cache_creation_input_tokens ?? 0;
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							break;
						}

						if (event?.type === "content_block_start") {
							if (event.content_block?.type === "text") {
								blocks.push({ type: "text", text: "" });
								const arrIndex = blocks.length - 1;
								blockIndexMap.set(event.index, arrIndex);
								stream.push({ type: "text_start", contentIndex: arrIndex, partial: output });
							} else if (event.content_block?.type === "thinking") {
								blocks.push({ type: "thinking", thinking: "", thinkingSignature: "" });
								const arrIndex = blocks.length - 1;
								blockIndexMap.set(event.index, arrIndex);
								stream.push({ type: "thinking_start", contentIndex: arrIndex, partial: output });
							} else if (event.content_block?.type === "tool_use") {
								sawToolCall = true;
								blocks.push({
									type: "toolCall",
									id: event.content_block.id,
									name: mapToolNameSdkToPi(event.content_block.name, customToolNameToPi),
									arguments: (event.content_block.input as Record<string, unknown>) ?? {},
								});
								const arrIndex = blocks.length - 1;
								blockIndexMap.set(event.index, arrIndex);
								blockTrackers.set(arrIndex, { partialJson: "" });
								stream.push({ type: "toolcall_start", contentIndex: arrIndex, partial: output });
							}
							break;
						}

						if (event?.type === "content_block_delta") {
							const index = blockIndexMap.get(event.index);
							if (index === undefined) break;
							const block = blocks[index];
							if (!block) break;

							if (event.delta?.type === "text_delta" && block.type === "text") {
								block.text += event.delta.text;
								stream.push({
									type: "text_delta",
									contentIndex: index,
									delta: event.delta.text,
									partial: output,
								});
							} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
								block.thinking += event.delta.thinking;
								stream.push({
									type: "thinking_delta",
									contentIndex: index,
									delta: event.delta.thinking,
									partial: output,
								});
							} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
								const tracker = blockTrackers.get(index);
								if (tracker) tracker.partialJson += event.delta.partial_json;
								// Skip intermediate parse — final parse happens at content_block_stop.
								// Avoids O(N^2) cumulative JSON parsing for large tool arguments.
								stream.push({
									type: "toolcall_delta",
									contentIndex: index,
									delta: event.delta.partial_json,
									partial: output,
								});
							} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
								block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
							}
							break;
						}

						if (event?.type === "content_block_stop") {
							const index = blockIndexMap.get(event.index);
							if (index === undefined) break;
							const block = blocks[index];
							if (!block) break;

							if (block.type === "text") {
								stream.push({
									type: "text_end",
									contentIndex: index,
									content: block.text,
									partial: output,
								});
							} else if (block.type === "thinking") {
								stream.push({
									type: "thinking_end",
									contentIndex: index,
									content: block.thinking,
									partial: output,
								});
							} else if (block.type === "toolCall") {
								sawToolCall = true;
								const tracker = blockTrackers.get(index);
								const partialJson = tracker?.partialJson ?? "";
								block.arguments = translateToolArgs(
									block.name,
									parsePartialJson(partialJson, block.arguments),
									translationCtx,
								);
								blockTrackers.delete(index);
								stream.push({
									type: "toolcall_end",
									contentIndex: index,
									toolCall: block,
									partial: output,
								});
							}
							break;
						}

						if (event?.type === "message_delta") {
							output.stopReason = mapStopReason(event.delta?.stop_reason ?? undefined);
							const usage = event.usage ?? {};
							if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
							if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
							if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
							if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							break;
						}

						if (event?.type === "message_stop" && sawToolCall) {
							output.stopReason = "toolUse";
							shouldStopEarly = true;
							break;
						}

						break;
					}

					case "result": {
						if (!sawStreamEvent && message.subtype === "success") {
							output.content.push({ type: "text", text: message.result || "" });
						}
						break;
					}
				}

				if (shouldStopEarly) {
					break;
				}
			}

			if (wasAborted || options?.signal?.aborted) {
				output.stopReason = "aborted";
				output.errorMessage = "Operation aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end();
				return;
			}

			stream.push({
				type: "done",
				reason: output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "length" ? "length" : "stop",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		} finally {
			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			sdkQuery?.close();
		}
	})();

	return stream;
}
