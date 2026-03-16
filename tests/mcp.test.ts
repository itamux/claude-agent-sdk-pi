import { describe, it, expect } from "vitest";
import { resolveSdkTools } from "../src/mcp.js";
import type { Context } from "@mariozechner/pi-ai";

describe("resolveSdkTools", () => {
	it("returns DEFAULT_TOOLS when context.tools is undefined", () => {
		const context = { messages: [] } as unknown as Context;
		const result = resolveSdkTools(context);
		expect(result.sdkTools).toEqual(["Read", "Write", "Edit", "Bash", "Grep", "Glob"]);
		expect(result.customTools).toEqual([]);
	});

	it("maps builtin pi tool names to SDK names", () => {
		const context = {
			messages: [],
			tools: [
				{ name: "read", description: "", parameters: {} },
				{ name: "bash", description: "", parameters: {} },
				{ name: "grep", description: "", parameters: {} },
			],
		} as unknown as Context;
		const result = resolveSdkTools(context);
		expect(result.sdkTools).toContain("Read");
		expect(result.sdkTools).toContain("Bash");
		expect(result.sdkTools).toContain("Grep");
		expect(result.customTools).toEqual([]);
	});

	it("maps find to Glob", () => {
		const context = {
			messages: [],
			tools: [{ name: "find", description: "", parameters: {} }],
		} as unknown as Context;
		const result = resolveSdkTools(context);
		expect(result.sdkTools).toContain("Glob");
	});

	it("maps glob alias to Glob", () => {
		const context = {
			messages: [],
			tools: [{ name: "glob", description: "", parameters: {} }],
		} as unknown as Context;
		const result = resolveSdkTools(context);
		expect(result.sdkTools).toContain("Glob");
	});

	it("separates custom tools from builtins", () => {
		const context = {
			messages: [],
			tools: [
				{ name: "read", description: "", parameters: {} },
				{ name: "my_search", description: "Search", parameters: { type: "object", properties: {} } },
			],
		} as unknown as Context;
		const result = resolveSdkTools(context);
		expect(result.sdkTools).toContain("Read");
		expect(result.customTools).toHaveLength(1);
		expect(result.customTools[0].name).toBe("my_search");
	});

	it("creates bidirectional name mappings for custom tools", () => {
		const context = {
			messages: [],
			tools: [
				{ name: "my_tool", description: "", parameters: {} },
			],
		} as unknown as Context;
		const result = resolveSdkTools(context);
		expect(result.customToolNameToSdk.get("my_tool")).toBe("mcp__custom-tools__my_tool");
		expect(result.customToolNameToPi.get("mcp__custom-tools__my_tool")).toBe("my_tool");
	});
});
