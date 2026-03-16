import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Context, Tool } from "@mariozechner/pi-ai";
import { z } from "zod";

import { BUILTIN_PI_NAMES, DEFAULT_TOOLS, MCP_SERVER_NAME, MCP_TOOL_PREFIX, TOOL_EXECUTION_DENIED_MESSAGE, mapToolNamePiToSdk } from "./handlers.js";

/**
 * Convert a TypeBox/JSON Schema property to a Zod type.
 *
 * The SDK's createSdkMcpServer expects Zod raw shapes (objects where values are ZodTypes).
 * TypeBox schemas are valid JSON Schema but fail the SDK's internal Zod detection (U9/nz),
 * causing all custom tool schemas to resolve to empty {type:"object",properties:{}}.
 *
 * This function converts JSON Schema property definitions to Zod types so the SDK
 * correctly exposes full parameter schemas to Claude.
 */
function jsonSchemaPropToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	const desc = typeof prop.description === "string" ? prop.description : undefined;
	let zodType: z.ZodTypeAny;

	switch (prop.type) {
		case "string":
			zodType = z.string();
			break;
		case "number":
			zodType = z.number();
			break;
		case "integer":
			zodType = z.number().int();
			break;
		case "boolean":
			zodType = z.boolean();
			break;
		case "array": {
			const items = prop.items as Record<string, unknown> | undefined;
			const itemType = items ? jsonSchemaPropToZod(items) : z.any();
			zodType = z.array(itemType);
			break;
		}
		case "object": {
			const nested = prop.properties as Record<string, Record<string, unknown>> | undefined;
			if (nested) {
				const shape = jsonSchemaToZodShape(nested, (prop.required as string[]) ?? []);
				zodType = (z.object as Function)(shape) as z.ZodTypeAny;
			} else {
				zodType = z.record(z.string(), z.any());
			}
			break;
		}
		default:
			zodType = z.any();
	}

	if (desc) zodType = zodType.describe(desc);

	if (Array.isArray(prop.enum)) {
		const values = prop.enum as [string, ...string[]];
		if (values.length > 0) {
			zodType = z.enum(values);
			if (desc) zodType = zodType.describe(desc);
		}
	}

	return zodType;
}

function jsonSchemaToZodShape(
	properties: Record<string, Record<string, unknown>>,
	required: string[],
): Record<string, z.ZodTypeAny> {
	const requiredSet = new Set(required);
	const shape: Record<string, z.ZodTypeAny> = {};

	for (const [key, prop] of Object.entries(properties)) {
		let zodType = jsonSchemaPropToZod(prop);
		if (!requiredSet.has(key)) {
			zodType = zodType.optional();
		}
		shape[key] = zodType;
	}

	return shape;
}

/**
 * Convert a TypeBox schema (or any JSON-Schema-compatible object) to a Zod raw shape.
 * Returns the shape object that createSdkMcpServer expects for inputSchema.
 */
function toZodShape(typeboxSchema: unknown): Record<string, z.ZodTypeAny> {
	if (!typeboxSchema || typeof typeboxSchema !== "object") {
		return {};
	}

	const schema = typeboxSchema as Record<string, unknown>;
	const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
	if (!properties || typeof properties !== "object") {
		return {};
	}

	// Deep-clone to strip TypeBox-specific Symbol keys before conversion
	const cloned = JSON.parse(JSON.stringify(properties)) as Record<string, Record<string, unknown>>;
	const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

	return jsonSchemaToZodShape(cloned, required);
}

export function buildCustomToolServers(customTools: Tool[]): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!customTools.length) return undefined;

	const mcpTools = customTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		// Convert TypeBox/JSON Schema to Zod raw shape so the SDK's internal
		// zodToJsonSchema conversion correctly produces full parameter schemas.
		inputSchema: toZodShape(tool.parameters),
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
			const sdkName = mapToolNamePiToSdk(normalized);
			sdkTools.add(sdkName);
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
