import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";

export interface TranslationContext {
	allowSkillAliasRewrite: boolean;
	resolvePath: (value: unknown) => unknown;
}

export interface ToolHandler {
	readonly sdkName: string;
	readonly piName: string;
	readonly piAliases?: readonly string[];
	translateArgs(sdkArgs: Record<string, unknown>, ctx: TranslationContext): Record<string, unknown>;
}

export type ProviderSettings = {
	appendSystemPrompt?: boolean;
	settingSources?: SettingSource[];
	strictMcpConfig?: boolean;
};
