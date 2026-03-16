import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettingsFile } from "../src/settings.js";

describe("readSettingsFile", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sdk-pi-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true });
	});

	it("returns empty object when file does not exist", () => {
		const result = readSettingsFile(join(dir, "nonexistent.json"));
		expect(result).toEqual({});
	});

	it("parses claudeAgentSdkProvider key", () => {
		const settings = {
			claudeAgentSdkProvider: {
				appendSystemPrompt: true,
				settingSources: ["user", "project"],
				strictMcpConfig: true,
			},
		};
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		const result = readSettingsFile(join(dir, "settings.json"));
		expect(result.appendSystemPrompt).toBe(true);
		expect(result.settingSources).toEqual(["user", "project"]);
		expect(result.strictMcpConfig).toBe(true);
	});

	it("parses claude-agent-sdk-provider key (kebab-case)", () => {
		const settings = {
			"claude-agent-sdk-provider": {
				appendSystemPrompt: false,
			},
		};
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		const result = readSettingsFile(join(dir, "settings.json"));
		expect(result.appendSystemPrompt).toBe(false);
	});

	it("parses claudeAgentSdk key (shortened)", () => {
		const settings = {
			claudeAgentSdk: {
				strictMcpConfig: false,
			},
		};
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		const result = readSettingsFile(join(dir, "settings.json"));
		expect(result.strictMcpConfig).toBe(false);
	});

	it("claudeAgentSdkProvider takes precedence over other keys", () => {
		const settings = {
			claudeAgentSdkProvider: { appendSystemPrompt: true },
			claudeAgentSdk: { appendSystemPrompt: false },
		};
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		const result = readSettingsFile(join(dir, "settings.json"));
		expect(result.appendSystemPrompt).toBe(true);
	});

	it("returns empty object for malformed JSON", () => {
		writeFileSync(join(dir, "settings.json"), "not json{{{");
		const result = readSettingsFile(join(dir, "settings.json"));
		expect(result).toEqual({});
	});

	it("returns empty object when no matching key exists", () => {
		const settings = { someOtherKey: { value: 42 } };
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		const result = readSettingsFile(join(dir, "settings.json"));
		expect(result).toEqual({});
	});

	it("ignores invalid settingSources values", () => {
		const settings = {
			claudeAgentSdkProvider: {
				settingSources: ["invalid", "also_invalid"],
			},
		};
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		const result = readSettingsFile(join(dir, "settings.json"));
		expect(result.settingSources).toBeUndefined();
	});

	it("accepts valid settingSources with local", () => {
		const settings = {
			claudeAgentSdkProvider: {
				settingSources: ["user", "project", "local"],
			},
		};
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		const result = readSettingsFile(join(dir, "settings.json"));
		expect(result.settingSources).toEqual(["user", "project", "local"]);
	});

	it("ignores non-boolean appendSystemPrompt", () => {
		const settings = {
			claudeAgentSdkProvider: {
				appendSystemPrompt: "yes",
			},
		};
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		const result = readSettingsFile(join(dir, "settings.json"));
		expect(result.appendSystemPrompt).toBeUndefined();
	});

	it("ignores non-boolean strictMcpConfig", () => {
		const settings = {
			claudeAgentSdkProvider: {
				strictMcpConfig: 1,
			},
		};
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		const result = readSettingsFile(join(dir, "settings.json"));
		expect(result.strictMcpConfig).toBeUndefined();
	});
});
