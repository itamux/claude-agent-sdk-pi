import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Context, Tool } from "@mariozechner/pi-ai";
import { BUILTIN_PI_NAMES, MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./handlers.js";
import { DEFAULT_TOOLS } from "./handlers.js";

const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution is unavailable in this environment.";

/**
 * Convert a TypeBox schema to a plain JSON Schema object.
 *
 * TypeBox schemas ARE valid JSON Schema, but the SDK's internal Zod detection
 * fails on TypeBox objects, causing schemas to resolve to empty {type:"object",properties:{}}.
 * By extracting the plain JSON Schema properties, we bypass the Zod detection path.
 */
function toJsonSchema(typeboxSchema: unknown): Record<string, unknown> {
	if (!typeboxSchema || typeof typeboxSchema !== "object") {
		return { type: "object", properties: {} };
	}

	const schema = typeboxSchema as Record<string, unknown>;

	// TypeBox schemas have a standard JSON Schema structure.
	// Extract the core fields that describe the schema.
	const jsonSchema: Record<string, unknown> = {
		type: schema.type ?? "object",
	};

	if (schema.properties && typeof schema.properties === "object") {
		// Deep-clone properties to strip any TypeBox-specific symbols
		jsonSchema.properties = JSON.parse(JSON.stringify(schema.properties));
	}

	if (Array.isArray(schema.required) && schema.required.length > 0) {
		jsonSchema.required = [...schema.required];
	}

	if (typeof schema.description === "string") {
		jsonSchema.description = schema.description;
	}

	if (typeof schema.additionalProperties !== "undefined") {
		jsonSchema.additionalProperties = schema.additionalProperties;
	}

	return jsonSchema;
}

export function buildCustomToolServers(customTools: Tool[]): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!customTools.length) return undefined;

	const mcpTools = customTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		// Fix: convert TypeBox schema to plain JSON Schema to avoid empty schema bug.
		// The SDK's Zod detection fails on TypeBox objects, so we pass raw JSON Schema.
		inputSchema: toJsonSchema(tool.parameters) as unknown,
		handler: async () => ({
			content: [{ type: "text" as const, text: TOOL_EXECUTION_DENIED_MESSAGE }],
			isError: true,
		}),
	}));

	const server = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		version: "1.0.0",
		tools: mcpTools,
	});

	return { [MCP_SERVER_NAME]: server };
}

export function resolveSdkTools(context: Context): {
	sdkTools: string[];
	customTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	if (!context.tools) {
		return {
			sdkTools: [...DEFAULT_TOOLS],
			customTools: [],
			customToolNameToSdk: new Map(),
			customToolNameToPi: new Map(),
		};
	}

	const sdkTools = new Set<string>();
	const customTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	for (const tool of context.tools) {
		const normalized = tool.name.toLowerCase();
		if (BUILTIN_PI_NAMES.has(normalized)) {
			// Use the handler's SDK name via lookup
			const handler = [...BUILTIN_PI_NAMES].includes(normalized);
			if (handler) {
				// Map pi name -> SDK name for builtin tools
				const PI_TO_SDK: Record<string, string> = {
					read: "Read", write: "Write", edit: "Edit",
					bash: "Bash", grep: "Grep", find: "Glob", glob: "Glob",
				};
				const sdkName = PI_TO_SDK[normalized];
				if (sdkName) sdkTools.add(sdkName);
			}
			continue;
		}
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		customTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(normalized, sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { sdkTools: Array.from(sdkTools), customTools, customToolNameToSdk, customToolNameToPi };
}
