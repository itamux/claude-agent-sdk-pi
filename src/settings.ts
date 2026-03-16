import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, normalize, relative, resolve } from "path";

import type { ProviderSettings } from "./types.js";

// --- Path constants ---

const SKILLS_ALIAS_GLOBAL = "~/.claude/skills";
const SKILLS_ALIAS_PROJECT = ".claude/skills";
const GLOBAL_SKILLS_ROOT = join(homedir(), ".pi", "agent", "skills");
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");

// Use functions for cwd-dependent paths to avoid stale values if cwd changes
function getProjectSkillsRoot(): string { return join(process.cwd(), ".pi", "skills"); }
function getProjectSettingsPath(): string { return join(process.cwd(), ".pi", "settings.json"); }

// --- Settings (cached with 5s TTL to avoid re-reading on every turn) ---

let cachedSettings: ProviderSettings | undefined;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL_MS = 5000;

export function loadProviderSettings(): ProviderSettings {
	const now = Date.now();
	if (cachedSettings && now - settingsCacheTime < SETTINGS_CACHE_TTL_MS) {
		return cachedSettings;
	}
	const globalSettings = readSettingsFile(GLOBAL_SETTINGS_PATH);
	const projectSettings = readSettingsFile(getProjectSettingsPath());
	cachedSettings = { ...globalSettings, ...projectSettings };
	settingsCacheTime = now;
	return cachedSettings;
}

export function readSettingsFile(filePath: string): ProviderSettings {
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const settingsBlock =
			(parsed["claudeAgentSdkProvider"] as Record<string, unknown> | undefined) ??
			(parsed["claude-agent-sdk-provider"] as Record<string, unknown> | undefined) ??
			(parsed["claudeAgentSdk"] as Record<string, unknown> | undefined);
		if (!settingsBlock || typeof settingsBlock !== "object") return {};
		const appendSystemPrompt =
			typeof settingsBlock["appendSystemPrompt"] === "boolean"
				? settingsBlock["appendSystemPrompt"]
				: undefined;

		const settingSourcesRaw = settingsBlock["settingSources"];
		const settingSources =
			Array.isArray(settingSourcesRaw) &&
			settingSourcesRaw.every(
				(value) =>
					typeof value === "string" && (value === "user" || value === "project" || value === "local"),
			)
				? (settingSourcesRaw as SettingSource[])
				: undefined;

		const strictMcpConfig =
			typeof settingsBlock["strictMcpConfig"] === "boolean" ? settingsBlock["strictMcpConfig"] : undefined;

		return {
			appendSystemPrompt,
			settingSources,
			strictMcpConfig,
		};
	} catch {
		return {};
	}
}

// --- Skills ---

export function extractSkillsAppend(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const startIndex = systemPrompt.indexOf(startMarker);
	if (startIndex === -1) return undefined;
	const endIndex = systemPrompt.indexOf(endMarker, startIndex);
	if (endIndex === -1) return undefined;
	const skillsBlock = systemPrompt.slice(startIndex, endIndex + endMarker.length).trim();
	return rewriteSkillsLocations(skillsBlock);
}

function rewriteSkillsLocations(skillsBlock: string): string {
	return skillsBlock.replace(/<location>([^<]+)<\/location>/g, (_match, location: string) => {
		let rewritten = location;
		if (location.startsWith(GLOBAL_SKILLS_ROOT)) {
			const relPath = relative(GLOBAL_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_GLOBAL}/${relPath}`.replace(/\/\/+/g, "/");
		} else if (location.startsWith(getProjectSkillsRoot())) {
			const relPath = relative(getProjectSkillsRoot(), location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_PROJECT}/${relPath}`.replace(/\/\/+/g, "/");
		}
		return `<location>${rewritten}</location>`;
	});
}

// --- Agents (cached — AGENTS.md location and content don't change mid-session) ---

let cachedAgentsAppend: string | undefined | null = null; // null = not yet cached

export function extractAgentsAppend(): string | undefined {
	if (cachedAgentsAppend !== null) return cachedAgentsAppend || undefined;
	const agentsPath = resolveAgentsMdPath();
	if (!agentsPath) {
		cachedAgentsAppend = "";
		return undefined;
	}
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) {
			cachedAgentsAppend = "";
			return undefined;
		}
		const sanitized = sanitizeAgentsContent(content);
		cachedAgentsAppend = sanitized.length > 0 ? `# CLAUDE.md\n\n${sanitized}` : "";
		return cachedAgentsAppend || undefined;
	} catch {
		cachedAgentsAppend = "";
		return undefined;
	}
}

function resolveAgentsMdPath(): string | undefined {
	const fromCwd = findAgentsMdInParents(process.cwd());
	if (fromCwd) return fromCwd;
	if (existsSync(GLOBAL_AGENTS_PATH)) return GLOBAL_AGENTS_PATH;
	return undefined;
}

function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function sanitizeAgentsContent(content: string): string {
	let sanitized = content;
	sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
	sanitized = sanitized.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
	sanitized = sanitized.replace(/\b\.pi\b/gi, ".claude");
	// Only replace standalone "pi" when it refers to the pi-coding-agent tool/runtime,
	// not in other contexts (API, mathematical pi, package names like pi-ai).
	// Match "pi" only when preceded by whitespace/start and followed by whitespace/punctuation/end.
	sanitized = sanitized.replace(/(^|[\s"'`(])pi([\s"'`).,:;!?]|$)/gi, "$1environment$2");
	return sanitized;
}

// --- Skill alias path rewriting ---

export function rewriteSkillAliasPath(pathValue: unknown): unknown {
	if (typeof pathValue !== "string") return pathValue;

	// Reject paths with traversal segments before rewriting
	const normalized = normalize(pathValue);
	if (normalized.includes("..")) return pathValue;

	if (pathValue.startsWith(SKILLS_ALIAS_GLOBAL)) {
		return pathValue.replace(SKILLS_ALIAS_GLOBAL, "~/.pi/agent/skills");
	}
	if (pathValue.startsWith(`./${SKILLS_ALIAS_PROJECT}`)) {
		return pathValue.replace(`./${SKILLS_ALIAS_PROJECT}`, getProjectSkillsRoot());
	}
	if (pathValue.startsWith(SKILLS_ALIAS_PROJECT)) {
		return pathValue.replace(SKILLS_ALIAS_PROJECT, getProjectSkillsRoot());
	}
	const projectAliasAbs = join(process.cwd(), SKILLS_ALIAS_PROJECT);
	if (pathValue.startsWith(projectAliasAbs)) {
		return pathValue.replace(projectAliasAbs, getProjectSkillsRoot());
	}
	return pathValue;
}

/** Build a TranslationContext from skill alias rewrite state */
export function buildTranslationContext(allowSkillAliasRewrite: boolean) {
	return {
		allowSkillAliasRewrite,
		resolvePath: (value: unknown) => (allowSkillAliasRewrite ? rewriteSkillAliasPath(value) : value),
	};
}
