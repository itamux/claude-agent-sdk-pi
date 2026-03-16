import { pascalCase } from "change-case";

import type { ToolHandler, TranslationContext } from "./types.js";

// --- Helpers ---

/** Coerce a value to a positive integer, or return undefined */
function toPositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

// --- Handler definitions ---

const readHandler: ToolHandler = {
	sdkName: "Read",
	piName: "read",
	translateArgs(args, ctx) {
		return {
			path: ctx.resolvePath(args.file_path ?? args.path),
			offset: toPositiveInt(args.offset),
			limit: toPositiveInt(args.limit),
			// pages: dropped — pi doesn't support PDF page ranges
		};
	},
};

const writeHandler: ToolHandler = {
	sdkName: "Write",
	piName: "write",
	translateArgs(args, ctx) {
		return {
			path: ctx.resolvePath(args.file_path ?? args.path),
			content: args.content,
		};
	},
};

const editHandler: ToolHandler = {
	sdkName: "Edit",
	piName: "edit",
	translateArgs(args, ctx) {
		return {
			path: ctx.resolvePath(args.file_path ?? args.path),
			oldText: args.old_string,
			newText: args.new_string,
			// replace_all: dropped — let Claude iterate with multiple edit calls.
			// Pi's edit tool rejects multi-occurrence matches by design.
		};
	},
};

const bashHandler: ToolHandler = {
	sdkName: "Bash",
	piName: "bash",
	translateArgs(args) {
		return {
			command: args.command,
			timeout: toPositiveInt(args.timeout),
			// Intentionally dropped (security-safer):
			// - description: cosmetic only
			// - run_in_background: pi doesn't support background execution
			// - dangerouslyDisableSandbox: dropping is security-positive
		};
	},
};

const grepHandler: ToolHandler = {
	sdkName: "Grep",
	piName: "grep",
	translateArgs(args, ctx) {
		return {
			pattern: args.pattern,
			path: ctx.resolvePath(args.path),
			glob: args.glob,
			ignoreCase: args["-i"] ?? undefined,
			context: toPositiveInt(args["-C"] ?? args.context),
			limit: toPositiveInt(args.head_limit ?? args.limit),
			// Dropped — pi has no equivalents:
			// output_mode, -B, -A, -n, type, offset, multiline
		};
	},
};

const globHandler: ToolHandler = {
	sdkName: "Glob",
	piName: "find",
	piAliases: ["glob"],
	translateArgs(args, ctx) {
		return {
			pattern: args.pattern,
			path: ctx.resolvePath(args.path),
		};
	},
};

// --- Handler registry ---

const ALL_HANDLERS: readonly ToolHandler[] = [
	readHandler,
	writeHandler,
	editHandler,
	bashHandler,
	grepHandler,
	globHandler,
];

/** Lookup by lowercase SDK name */
const BY_SDK_NAME: Record<string, ToolHandler> = {};
/** Lookup by lowercase pi name */
const BY_PI_NAME: Record<string, ToolHandler> = {};

for (const handler of ALL_HANDLERS) {
	BY_SDK_NAME[handler.sdkName.toLowerCase()] = handler;
	BY_PI_NAME[handler.piName.toLowerCase()] = handler;
	if (handler.piAliases) {
		for (const alias of handler.piAliases) {
			BY_PI_NAME[alias.toLowerCase()] = handler;
		}
	}
}

/** All SDK tool names (PascalCase) for the builtin tools */
export const DEFAULT_TOOLS: readonly string[] = ALL_HANDLERS.map((h) => h.sdkName);

/** Set of all pi tool names (lowercase) that are builtin */
export const BUILTIN_PI_NAMES: ReadonlySet<string> = new Set(
	ALL_HANDLERS.flatMap((h) => [h.piName, ...(h.piAliases ?? [])]),
);

/** Map tool name from SDK (e.g. "Read") -> pi (e.g. "read") */
export function mapToolNameSdkToPi(
	name: string,
	customToolNameToPi?: Map<string, string>,
): string {
	const normalized = name.toLowerCase();

	const handler = BY_SDK_NAME[normalized];
	if (handler) return handler.piName;

	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}

	if (normalized.startsWith(MCP_TOOL_PREFIX)) {
		return name.slice(MCP_TOOL_PREFIX.length);
	}

	return name;
}

/** Map tool name from pi (e.g. "read") -> SDK (e.g. "Read") */
export function mapToolNamePiToSdk(
	name: string | undefined,
	customToolNameToSdk?: Map<string, string>,
): string {
	if (!name) return "";
	const normalized = name.toLowerCase();

	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}

	const handler = BY_PI_NAME[normalized];
	if (handler) return handler.sdkName;

	return pascalCase(name);
}

/** Translate SDK tool args to pi tool args */
export function translateToolArgs(
	piToolName: string,
	args: Record<string, unknown> | undefined,
	ctx: TranslationContext,
): Record<string, unknown> {
	const input = args ?? {};
	const handler = BY_PI_NAME[piToolName.toLowerCase()];
	if (handler) {
		return handler.translateArgs(input, ctx);
	}
	// Unknown/custom tools: pass through unchanged
	return input;
}

// Shared constants
export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
export const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution is unavailable in this environment.";
