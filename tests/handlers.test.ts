import { describe, it, expect } from "vitest";
import {
	mapToolNameSdkToPi,
	mapToolNamePiToSdk,
	translateToolArgs,
	DEFAULT_TOOLS,
	BUILTIN_PI_NAMES,
	MCP_TOOL_PREFIX,
} from "../src/handlers.js";
import type { TranslationContext } from "../src/types.js";

// --- Test helpers ---

const noRewriteCtx: TranslationContext = {
	allowSkillAliasRewrite: false,
	resolvePath: (v) => v,
};

const rewriteCtx: TranslationContext = {
	allowSkillAliasRewrite: true,
	resolvePath: (v) => {
		if (typeof v === "string" && v.startsWith("~/.claude/skills")) {
			return v.replace("~/.claude/skills", "~/.pi/agent/skills");
		}
		return v;
	},
};

// ================================================================
// Handler translateArgs tests
// ================================================================

describe("Read handler", () => {
	it("maps file_path to path", () => {
		const result = translateToolArgs("read", { file_path: "/tmp/test.ts" }, noRewriteCtx);
		expect(result).toEqual({ path: "/tmp/test.ts", offset: undefined, limit: undefined });
	});

	it("maps path when file_path is absent", () => {
		const result = translateToolArgs("read", { path: "/tmp/test.ts" }, noRewriteCtx);
		expect(result).toEqual({ path: "/tmp/test.ts", offset: undefined, limit: undefined });
	});

	it("passes through offset and limit as integers", () => {
		const result = translateToolArgs("read", { file_path: "/f.ts", offset: 10, limit: 50 }, noRewriteCtx);
		expect(result.offset).toBe(10);
		expect(result.limit).toBe(50);
	});

	it("rejects non-numeric offset and limit", () => {
		const result = translateToolArgs("read", { file_path: "/f.ts", offset: "abc", limit: -5 }, noRewriteCtx);
		expect(result.offset).toBeUndefined();
		expect(result.limit).toBeUndefined();
	});

	it("drops pages (pi unsupported)", () => {
		const result = translateToolArgs("read", { file_path: "/f.pdf", pages: "1-5" }, noRewriteCtx);
		expect(result).not.toHaveProperty("pages");
	});

	it("rewrites skill alias paths when enabled", () => {
		const result = translateToolArgs("read", { file_path: "~/.claude/skills/my-skill.md" }, rewriteCtx);
		expect(result.path).toBe("~/.pi/agent/skills/my-skill.md");
	});

	it("does not rewrite paths when disabled", () => {
		const result = translateToolArgs("read", { file_path: "~/.claude/skills/my-skill.md" }, noRewriteCtx);
		expect(result.path).toBe("~/.claude/skills/my-skill.md");
	});

	it("handles undefined args", () => {
		const result = translateToolArgs("read", undefined, noRewriteCtx);
		expect(result).toEqual({ path: undefined, offset: undefined, limit: undefined });
	});

	it("handles empty object", () => {
		const result = translateToolArgs("read", {}, noRewriteCtx);
		expect(result).toEqual({ path: undefined, offset: undefined, limit: undefined });
	});
});

describe("Write handler", () => {
	it("maps file_path to path and passes content", () => {
		const result = translateToolArgs("write", { file_path: "/tmp/f.ts", content: "hello" }, noRewriteCtx);
		expect(result).toEqual({ path: "/tmp/f.ts", content: "hello" });
	});

	it("accepts empty string content", () => {
		const result = translateToolArgs("write", { file_path: "/f.ts", content: "" }, noRewriteCtx);
		expect(result.content).toBe("");
	});

	it("handles undefined args", () => {
		const result = translateToolArgs("write", undefined, noRewriteCtx);
		expect(result).toEqual({ path: undefined, content: undefined });
	});
});

describe("Edit handler", () => {
	it("maps old_string/new_string to oldText/newText", () => {
		const result = translateToolArgs("edit", {
			file_path: "/f.ts",
			old_string: "foo",
			new_string: "bar",
		}, noRewriteCtx);
		expect(result).toEqual({ path: "/f.ts", oldText: "foo", newText: "bar" });
	});

	it("strictly uses old_string format (no guessing oldText)", () => {
		const result = translateToolArgs("edit", {
			file_path: "/f.ts",
			oldText: "foo",
			newText: "bar",
		}, noRewriteCtx);
		// Should use old_string, not oldText — oldText goes to undefined
		expect(result.oldText).toBeUndefined();
		expect(result.newText).toBeUndefined();
	});

	it("drops replace_all", () => {
		const result = translateToolArgs("edit", {
			file_path: "/f.ts",
			old_string: "foo",
			new_string: "bar",
			replace_all: true,
		}, noRewriteCtx);
		expect(result).not.toHaveProperty("replace_all");
	});

	it("handles undefined args", () => {
		const result = translateToolArgs("edit", undefined, noRewriteCtx);
		expect(result).toEqual({ path: undefined, oldText: undefined, newText: undefined });
	});
});

describe("Bash handler", () => {
	it("passes command and timeout", () => {
		const result = translateToolArgs("bash", { command: "ls -la", timeout: 5000 }, noRewriteCtx);
		expect(result.command).toBe("ls -la");
		expect(result.timeout).toBe(5000);
	});

	it("rejects non-numeric timeout", () => {
		const result = translateToolArgs("bash", { command: "ls", timeout: "slow" }, noRewriteCtx);
		expect(result.timeout).toBeUndefined();
	});

	it("drops description", () => {
		const result = translateToolArgs("bash", { command: "ls", description: "List files" }, noRewriteCtx);
		expect(result).not.toHaveProperty("description");
	});

	it("drops run_in_background", () => {
		const result = translateToolArgs("bash", { command: "sleep 10", run_in_background: true }, noRewriteCtx);
		expect(result).not.toHaveProperty("run_in_background");
	});

	it("drops dangerouslyDisableSandbox", () => {
		const result = translateToolArgs("bash", { command: "rm -rf /", dangerouslyDisableSandbox: true }, noRewriteCtx);
		expect(result).not.toHaveProperty("dangerouslyDisableSandbox");
	});

	it("handles undefined args", () => {
		const result = translateToolArgs("bash", undefined, noRewriteCtx);
		expect(result).toEqual({ command: undefined, timeout: undefined });
	});
});

describe("Grep handler", () => {
	it("maps basic fields", () => {
		const result = translateToolArgs("grep", { pattern: "TODO", path: "/src" }, noRewriteCtx);
		expect(result.pattern).toBe("TODO");
		expect(result.path).toBe("/src");
	});

	it("maps -i to ignoreCase", () => {
		const result = translateToolArgs("grep", { pattern: "todo", "-i": true }, noRewriteCtx);
		expect(result.ignoreCase).toBe(true);
	});

	it("maps -i false to ignoreCase false", () => {
		const result = translateToolArgs("grep", { pattern: "todo", "-i": false }, noRewriteCtx);
		expect(result.ignoreCase).toBe(false);
	});

	it("maps -C to context", () => {
		const result = translateToolArgs("grep", { pattern: "todo", "-C": 3 }, noRewriteCtx);
		expect(result.context).toBe(3);
	});

	it("maps context field to context", () => {
		const result = translateToolArgs("grep", { pattern: "todo", context: 5 }, noRewriteCtx);
		expect(result.context).toBe(5);
	});

	it("-C takes precedence over context", () => {
		const result = translateToolArgs("grep", { pattern: "todo", "-C": 3, context: 5 }, noRewriteCtx);
		expect(result.context).toBe(3);
	});

	it("maps head_limit to limit", () => {
		const result = translateToolArgs("grep", { pattern: "todo", head_limit: 100 }, noRewriteCtx);
		expect(result.limit).toBe(100);
	});

	it("head_limit takes precedence over limit", () => {
		const result = translateToolArgs("grep", { pattern: "todo", head_limit: 50, limit: 100 }, noRewriteCtx);
		expect(result.limit).toBe(50);
	});

	it("passes glob through", () => {
		const result = translateToolArgs("grep", { pattern: "todo", glob: "*.ts" }, noRewriteCtx);
		expect(result.glob).toBe("*.ts");
	});

	it("drops output_mode", () => {
		const result = translateToolArgs("grep", { pattern: "todo", output_mode: "content" }, noRewriteCtx);
		expect(result).not.toHaveProperty("output_mode");
	});

	it("drops -B, -A, -n, type, offset, multiline", () => {
		const result = translateToolArgs("grep", {
			pattern: "todo",
			"-B": 2, "-A": 2, "-n": true,
			type: "ts", offset: 10, multiline: true,
		}, noRewriteCtx);
		expect(result).not.toHaveProperty("-B");
		expect(result).not.toHaveProperty("-A");
		expect(result).not.toHaveProperty("-n");
		expect(result).not.toHaveProperty("type");
		expect(result).not.toHaveProperty("offset");
		expect(result).not.toHaveProperty("multiline");
	});

	it("handles undefined args", () => {
		const result = translateToolArgs("grep", undefined, noRewriteCtx);
		expect(result.pattern).toBeUndefined();
	});

	it("rewrites path when enabled", () => {
		const result = translateToolArgs("grep", { pattern: "foo", path: "~/.claude/skills/test" }, rewriteCtx);
		expect(result.path).toBe("~/.pi/agent/skills/test");
	});
});

describe("Glob/Find handler", () => {
	it("maps pattern and path", () => {
		const result = translateToolArgs("find", { pattern: "*.ts", path: "/src" }, noRewriteCtx);
		expect(result).toEqual({ pattern: "*.ts", path: "/src" });
	});

	it("handles undefined path", () => {
		const result = translateToolArgs("find", { pattern: "*.ts" }, noRewriteCtx);
		expect(result).toEqual({ pattern: "*.ts", path: undefined });
	});

	it("handles undefined args", () => {
		const result = translateToolArgs("find", undefined, noRewriteCtx);
		expect(result).toEqual({ pattern: undefined, path: undefined });
	});
});

describe("Unknown/custom tool handler", () => {
	it("passes args through unchanged", () => {
		const args = { custom_field: "value", count: 42 };
		const result = translateToolArgs("my_custom_tool", args, noRewriteCtx);
		expect(result).toBe(args); // same reference
	});

	it("returns empty object for undefined args", () => {
		const result = translateToolArgs("unknown_tool", undefined, noRewriteCtx);
		expect(result).toEqual({});
	});
});

// ================================================================
// Name mapping tests
// ================================================================

describe("mapToolNameSdkToPi", () => {
	it("maps builtin SDK names to pi names", () => {
		expect(mapToolNameSdkToPi("Read")).toBe("read");
		expect(mapToolNameSdkToPi("Write")).toBe("write");
		expect(mapToolNameSdkToPi("Edit")).toBe("edit");
		expect(mapToolNameSdkToPi("Bash")).toBe("bash");
		expect(mapToolNameSdkToPi("Grep")).toBe("grep");
		expect(mapToolNameSdkToPi("Glob")).toBe("find");
	});

	it("is case-insensitive", () => {
		expect(mapToolNameSdkToPi("read")).toBe("read");
		expect(mapToolNameSdkToPi("READ")).toBe("read");
		expect(mapToolNameSdkToPi("glob")).toBe("find");
	});

	it("strips MCP prefix", () => {
		expect(mapToolNameSdkToPi("mcp__custom-tools__search_web")).toBe("search_web");
	});

	it("uses customToolNameToPi map when provided", () => {
		const custom = new Map([["mcp__custom-tools__foo", "foo_tool"]]);
		expect(mapToolNameSdkToPi("mcp__custom-tools__foo", custom)).toBe("foo_tool");
	});

	it("passes unknown names through unchanged", () => {
		expect(mapToolNameSdkToPi("SomeUnknownTool")).toBe("SomeUnknownTool");
	});

	it("handles empty string", () => {
		expect(mapToolNameSdkToPi("")).toBe("");
	});
});

describe("mapToolNamePiToSdk", () => {
	it("maps builtin pi names to SDK names", () => {
		expect(mapToolNamePiToSdk("read")).toBe("Read");
		expect(mapToolNamePiToSdk("write")).toBe("Write");
		expect(mapToolNamePiToSdk("edit")).toBe("Edit");
		expect(mapToolNamePiToSdk("bash")).toBe("Bash");
		expect(mapToolNamePiToSdk("grep")).toBe("Grep");
		expect(mapToolNamePiToSdk("find")).toBe("Glob");
	});

	it("maps glob alias to Glob", () => {
		expect(mapToolNamePiToSdk("glob")).toBe("Glob");
	});

	it("is case-insensitive", () => {
		expect(mapToolNamePiToSdk("READ")).toBe("Read");
		expect(mapToolNamePiToSdk("GREP")).toBe("Grep");
	});

	it("uses customToolNameToSdk map when provided", () => {
		const custom = new Map([["my_tool", "mcp__custom-tools__my_tool"]]);
		expect(mapToolNamePiToSdk("my_tool", custom)).toBe("mcp__custom-tools__my_tool");
	});

	it("falls back to pascalCase for unknown names", () => {
		expect(mapToolNamePiToSdk("my_custom_tool")).toBe("MyCustomTool");
	});

	it("returns empty string for undefined", () => {
		expect(mapToolNamePiToSdk(undefined)).toBe("");
	});

	it("returns empty string for empty string", () => {
		expect(mapToolNamePiToSdk("")).toBe("");
	});
});

// ================================================================
// Registry constants tests
// ================================================================

describe("DEFAULT_TOOLS", () => {
	it("contains all 6 builtin SDK tool names", () => {
		expect(DEFAULT_TOOLS).toEqual(["Read", "Write", "Edit", "Bash", "Grep", "Glob"]);
	});
});

describe("BUILTIN_PI_NAMES", () => {
	it("contains all pi tool names including aliases", () => {
		expect(BUILTIN_PI_NAMES.has("read")).toBe(true);
		expect(BUILTIN_PI_NAMES.has("write")).toBe(true);
		expect(BUILTIN_PI_NAMES.has("edit")).toBe(true);
		expect(BUILTIN_PI_NAMES.has("bash")).toBe(true);
		expect(BUILTIN_PI_NAMES.has("grep")).toBe(true);
		expect(BUILTIN_PI_NAMES.has("find")).toBe(true);
		expect(BUILTIN_PI_NAMES.has("glob")).toBe(true); // alias
	});

	it("does not contain non-builtin names", () => {
		expect(BUILTIN_PI_NAMES.has("unknown")).toBe(false);
		expect(BUILTIN_PI_NAMES.has("WebSearch")).toBe(false);
	});
});
