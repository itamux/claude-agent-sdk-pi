---
title: "feat: Tool Mapping Registry Overhaul"
type: feat
status: completed
date: 2026-03-16
origin: docs/brainstorms/2026-03-16-tool-mapping-overhaul-brainstorm.md
---

# Tool Mapping Registry Overhaul

## Enhancement Summary

**Deepened on:** 2026-03-16
**Agents used:** TypeScript reviewer, architecture strategist, MCP engineer, YAGNI reviewer, performance oracle, security sentinel, test automator, AI engineer (Agent SDK), pattern recognition specialist

### Critical Discovery

**TypeBox schemas produce empty MCP tool schemas.** Custom tools registered via `createSdkMcpServer()` pass TypeBox schemas as `inputSchema` via `as unknown`. The SDK's internal Zod detection fails on TypeBox objects, causing all custom tool schemas to resolve to `{type:"object",properties:{}}`. Claude sees custom tools but has **zero parameter information** — it must guess arguments from the tool description alone. This is a pre-existing bug that must be fixed regardless of the refactor.

### Key Improvements from Review

1. **Simplified architecture**: Plain handler record + factory function instead of ToolRegistry class (YAGNI)
2. **Don't implement `replace_all`**: Let Claude iterate with multiple edit calls instead (architecture review)
3. **Add `TranslationContext`**: Shared context for path rewriting across handlers (pattern analysis)
4. **Fix TypeBox schema loss**: Convert to Zod or raw JSON Schema at registration (MCP review)
5. **Add `persistSession: false`**: Avoid wasted disk I/O from SDK session files (AI engineer)
6. **Security gates**: Agent recursion limits + WebFetch SSRF protection required before those phases
7. **Performance caching**: Cache settings, agents/skills appends, and MCP servers between turns

### Scope Simplification

The YAGNI review strongly recommends cutting Phases 2-4 (WebSearch/WebFetch, Agent, MCP improvements) as speculative for a personal fork. The core deliverable is: **fix arg dropping bugs + fix TypeBox schema loss + add tests.** Later phases remain documented but are optional — implement only when a concrete need arises.

## Overview

Fix critical argument translation gaps and TypeBox schema loss in `claude-agent-sdk-pi`. Refactor hardcoded tool mapping into handler functions with tests. This is a personal/team-use fork.

## Problem Statement

The current single-file extension (`index.ts`, 875 lines) has critical issues:

1. **Silent argument dropping**: `mapToolArgs()` drops `replace_all` (Edit), `pages` (Read), `run_in_background` (Bash), and 9+ grep parameters — the model thinks these were applied but they weren't
2. **TypeBox schema loss** (NEW): Custom MCP tools advertised to Claude have empty `{type:"object",properties:{}}` schemas — Claude cannot see parameter definitions
3. **Brittle arg guessing**: Code like `input.old_string ?? input.oldText ?? input.old_text` masks bugs
4. **No error distinction**: Tool results flatten to text with no error/success differentiation
5. **No tests**: Zero test coverage on the most critical translation logic

(see brainstorm: docs/brainstorms/2026-03-16-tool-mapping-overhaul-brainstorm.md)

## Proposed Solution

Replace inline switch/if chains with handler functions using a factory pattern. Fix all argument translation gaps. Fix TypeBox schema loss. Add comprehensive tests. Deliver in 2 focused steps (not 6 phases).

## Technical Approach

### Architecture

#### Tool Handler Type (Simplified)

```typescript
interface TranslationContext {
  allowSkillAliasRewrite: boolean;
  cwd?: string;
}

interface ToolHandler {
  readonly sdkName: string;        // e.g. "Read"
  readonly piName: string;         // e.g. "read"
  readonly piAliases?: readonly string[];  // e.g. ["glob"] for find/glob dual mapping
  translateArgs(sdkArgs: Record<string, unknown>, ctx: TranslationContext): Record<string, unknown>;
}
```

### Research Insights

**Why no `translateResult` or `handleError`:**
- Tool results are never translated per-tool today — they are uniformly flattened to text in `buildPromptBlocks()`
- Adding optional methods that zero handlers implement is dead interface surface (TypeScript reviewer, YAGNI reviewer, architecture strategist all agree)
- Add these when a concrete per-tool result translation need arises

**Why no ToolRegistry class:**
- 6 tools. A `Map`-based class with `register()`, `getBySDKName()`, `getByPiName()`, `getAllSDKNames()` is ~40-60 lines of boilerplate for a plain object lookup (YAGNI reviewer)
- Use a simple `Record<string, ToolHandler>` keyed by lowercase SDK name
- Reverse lookup (pi name -> SDK name) is rare — a `find()` on 6 entries is fine

**Why a factory function instead of classes:**
- Each handler is 10-20 lines of argument mapping — no state, no lifecycle (pattern analyst)
- Factory fills in defaults (shared `resolvePath` logic) and keeps handlers minimal

#### Handler Factory Pattern

```typescript
function createHandler(config: {
  sdkName: string;
  piName: string;
  piAliases?: string[];
  translateArgs: (args: Record<string, unknown>, ctx: TranslationContext) => Record<string, unknown>;
}): ToolHandler {
  return { ...config, piAliases: config.piAliases ?? [] };
}

// Example:
const readHandler = createHandler({
  sdkName: "Read",
  piName: "read",
  translateArgs: (args, ctx) => ({
    path: ctx.resolvePath(args.file_path ?? args.path),
    offset: args.offset,
    limit: args.limit,
    // pages: dropped — pi doesn't support PDF page ranges
  }),
});
```

#### File Structure (Simplified)

```
index.ts                    # Entry point — thin wiring
src/
  handlers.ts               # All 6 handler definitions + handler record
  types.ts                  # ToolHandler, TranslationContext interfaces
  streaming.ts              # streamClaudeAgentSdk extracted
  prompt.ts                 # buildPromptBlocks extracted
  settings.ts               # Provider settings + skills/agents loading
  mcp.ts                    # MCP server setup + TypeBox-to-JSON-Schema fix
tests/
  handlers.test.ts          # All handler translateArgs tests
  name-maps.test.ts         # Bidirectional name mapping tests
  settings.test.ts          # Settings file parsing tests
  fixtures/
    sdk-args.ts             # SDK argument fixtures
vitest.config.ts
tsconfig.test.json
```

### Research Insights (File Structure)

**Why not one file per handler:**
- Each handler is 10-20 lines. Six files with 15 lines each is worse than one file with 90 lines (TypeScript reviewer, YAGNI reviewer)
- Split when a handler grows complex enough to justify isolation (e.g., if WebFetch needs HTML parsing)

**`.js` extension spike required:**
- Before splitting, create a minimal two-file test: put one function in `src/test-import.ts`, import from `index.ts` with `.js` extension, verify pi loads it (TypeScript reviewer)
- Pi loads `.ts` directly — NodeNext requires `.js` extensions but pi's loader may intercept them differently

### Implementation Steps

#### Step 1: SDK Bump + TypeBox Fix + Arg Translation Fix + Tests

**Goal:** Fix all critical bugs, add tests, restructure into handler functions.

**Tasks:**

- [ ] **Spike**: Create two-file import test to verify pi handles multi-file `.ts` loading
- [ ] Bump `@anthropic-ai/claude-agent-sdk` to `^0.2.76`, verify nothing breaks
- [ ] Add `persistSession: false` to query options (avoid wasted disk I/O)
- [ ] **Fix TypeBox schema loss**: Convert TypeBox schemas to raw JSON Schema objects at MCP registration time (the `inputSchema` field). TypeBox schemas ARE valid JSON Schema — extract with `Type.Strict()` or pass the plain object properties directly instead of the full TypeBox wrapper
- [ ] Create `src/types.ts` with `ToolHandler` and `TranslationContext` interfaces
- [ ] Create `src/handlers.ts` with all 6 handlers using factory pattern
- [ ] Replace `mapToolName()`, `mapToolArgs()`, and name maps in `index.ts` with handler record lookups
- [ ] Extract `streamClaudeAgentSdk` to `src/streaming.ts`, `buildPromptBlocks` to `src/prompt.ts`
- [ ] Set up Vitest with `tsconfig.test.json` (bundler resolution) + `vitest.config.ts`
- [ ] Write tests: ~120-150 test cases across handlers, name maps, settings
- [ ] Preserve opus-4-6 thinking budget workaround
- [ ] Remove dead code: `legacyDisable` variable (line 276)
- [ ] Enable `strictNullChecks` and `noImplicitAny` in tsconfig (at minimum for `src/`)

**Argument mapping fixes per tool:**

| Tool | Fix | Detail |
|------|-----|--------|
| **Read** | Drop `pages` with comment | Pi doesn't support PDF page ranges; document the gap |
| **Write** | No changes | Mapping is correct |
| **Edit** | Remove arg guessing | Strictly expect `old_string`, `new_string` (SDK format only) |
| **Edit** | Don't implement `replace_all` | Let Claude iterate with multiple edit calls. Track if this causes problems. Propose `replaceAll` to pi upstream if needed. |
| **Bash** | Drop `description`, `run_in_background`, `dangerouslyDisableSandbox` with comments | Security-safer (confirmed by security review); `run_in_background` pi doesn't support |
| **Grep** | Map `-i` -> `ignoreCase` | Direct mapping — currently silently dropped |
| **Grep** | Map `-C`/`context` -> `context` | Direct mapping — currently silently dropped |
| **Grep** | Map `head_limit` -> `limit` | Already partially done; make explicit |
| **Grep** | Drop unsupported params with comments | `output_mode`, `-B`, `-A`, `-n`, `type`, `offset`, `multiline` — pi has no equivalents |
| **Glob** | No changes | Mapping is correct |

### Research Insights (Arg Translation)

**Why NOT implement `replace_all`:**
The architecture strategist identified three problems: (1) the handler would need `fs` access, bypassing pi's write pipeline and safety checks; (2) pi's session log would show "edit" but the actual operation was read+write; (3) pi's edit tool already rejects multi-occurrence matches by design. Let Claude iterate — it handles multiple edits naturally. If this becomes a pain point, propose `replaceAll: boolean` to pi's edit tool upstream. (see: architecture review Finding 4.1)

**Why strict arg expectations:**
The current `old_string ?? oldText ?? old_text` pattern masks bugs (pattern analyst). The SDK always sends `old_string` — guessing other formats means bugs in the SDK's schema would be silently accepted. Strict expectations catch issues early.

**Result translation:**
- [ ] Add error/success distinction: when `piResult.isError === true`, prefix result text with `"ERROR: "` so the model knows the tool failed
- [ ] Keep text-flattening approach (changing to structured `tool_result` blocks requires persistent subprocess — see Open Questions)

**Acceptance criteria:**
- [ ] All 6 handlers pass unit tests for arg translation
- [ ] TypeBox schemas correctly produce full JSON Schema in MCP tool definitions
- [ ] Grep maps `-i` to `ignoreCase` and `-C`/`context` to `context`
- [ ] Extension works end-to-end with pi (manual verification)
- [ ] No behavioral regression for existing tool calls
- [ ] `persistSession: false` prevents SDK session file creation
- [ ] Vitest tests pass (~120-150 cases)

#### Step 2: Future Tools (Optional — implement only when needed)

These phases are documented for reference but should only be implemented when a concrete need arises. Each has specific prerequisites identified by the review agents.

**WebSearch + WebFetch** (if needed):
- Register tools via `pi.registerTool()` AND expose via MCP server (both needed — architecture review)
- WebFetch SSRF protection required: block private/loopback/link-local addresses, restrict to http/https, validate redirect targets, enforce response size limit (security review — HIGH severity)
- WebFetch: return cleaned text, let main model handle `prompt` parameter (no secondary LLM call)
- WebSearch: ensure API keys injected server-side, never in tool args or context

**Agent/Subagent** (if needed):
- Use SDK's built-in `agents` option with `AgentDefinition` objects rather than manually spawning `query()` calls (AI engineer recommendation)
- Agent recursion limits required: max depth 2-3, max concurrent 5-10, per-subagent `maxTurns`/`maxBudgetUsd` caps (security review — HIGH severity)
- Subagent tool set should NOT include the Agent tool itself unless recursion depth is strictly controlled
- Wire parent's AbortSignal to all active subagent queries

**MCP improvements** (if needed):
- Move MCP phase BEFORE Agent phase (architecture strategist) — Agent tool needs proper MCP namespace
- Use fully-qualified `mcp__<server>__<tool>` keys in reverse mapping (MCP engineer)
- `setMcpServers()` not needed initially — current query-creation-time registration is sufficient
- Cache MCP server objects when tool list hasn't changed between turns

**MultiEdit** (if needed):
- Sequential application, no transactional rollback (YAGNI for single-user TUI)
- If one edit fails, stop and report which succeeded/failed. User has git for rollback.

## System-Wide Impact

- **Interaction graph**: Tool calls flow through handler record lookup instead of inline switch/if. The streaming pipeline calls `handlers[sdkName].translateArgs()` on `content_block_stop`. Pi's tool execution is unchanged.
- **Error propagation**: Error results prefixed with `"ERROR: "` in text flattening (distinguishable from success for the first time).
- **State lifecycle risks**: No `replace_all` implementation means no read-modify-write race. All handlers are stateless pure functions.
- **API surface parity**: The handler record exposes the same set of tools as before. No new tools in Step 1.

### Performance Considerations

(from performance oracle)

- **O(n^2) token growth**: `buildPromptBlocks()` rebuilds entire conversation as text every turn. This is the binding constraint — at ~20-30 turns, prompts approach context window limits. Investigate SDK's `streamInput()` for persistent subprocess in a future phase.
- **Cache between turns**: `loadProviderSettings()`, `extractAgentsAppend()`, `extractSkillsAppend()`, and `buildCustomToolServers()` all run on every turn but produce stable results. Cache with simple invalidation.
- **`findIndex` in hot loop**: Replace `blocks.findIndex(b => b.index === event.index)` with `Map<number, number>` index lookup. Low impact but clean O(1) optimization.
- **Remove `parsePartialJson` from delta handler**: Only parse at `content_block_stop` if partial tool args aren't needed for UI rendering.

### Security Considerations

(from security sentinel)

- **Bash `dangerouslyDisableSandbox` drop**: Confirmed safe — security-positive behavior
- **Silent arg dropping**: Security-positive — never log dropped argument values, only field names behind a debug flag
- **Schema-only MCP stub pattern**: Architecturally sound — `canUseTool` deny prevents SDK execution, pi handles all tool execution

## Acceptance Criteria

### Functional Requirements

- [ ] All 6 existing tools work identically after refactor (no behavioral regression)
- [ ] TypeBox schema loss fixed — custom MCP tools have full parameter schemas
- [ ] Grep maps `-i` -> `ignoreCase`, `-C`/`context` -> `context`
- [ ] Error results are distinguishable from success results
- [ ] `persistSession: false` prevents SDK session files

### Non-Functional Requirements

- [ ] Handler functions have unit tests (~120-150 cases)
- [ ] `strictNullChecks` + `noImplicitAny` enabled (at minimum for `src/`)
- [ ] No `as any` casts in new handler code
- [ ] Opus-4-6 thinking budget workaround preserved

### Quality Gates

- [ ] All Vitest tests pass
- [ ] Manual end-to-end test with pi

## Testing Strategy

(from test automator)

### Vitest Configuration

- `vitest.config.ts`: environment `node`, include `tests/**/*.test.ts`, V8 coverage excluding `src/streaming.ts`
- `tsconfig.test.json`: extends root, overrides `module: "ES2022"`, `moduleResolution: "bundler"` for Vitest compatibility
- Dev dependencies: `vitest ^3.2.4`, `@vitest/coverage-v8 ^3.2.4`

### Test Priority Order

1. `tests/handlers.test.ts` — grep `-i`/`-C` gaps and edit strict args are active bugs
2. `tests/name-maps.test.ts` — `glob`/`find` alias and case normalization
3. `tests/settings.test.ts` — three key aliases and malformed JSON handling

### What NOT to Test in Step 1

- `streamClaudeAgentSdk()` — requires mocking complex async iterable + Query lifecycle
- `buildPromptBlocks()` — depends on MessageParam shapes, deferred
- Pi extension factory (default export) — purely wiring

### Test Fixtures

- `tests/fixtures/sdk-args.ts`: typed constants for SDK argument shapes per tool
- `tests/helpers/tmp.ts`: temp directory helper for settings file tests

## Dependencies & Risks

| Risk | Mitigation |
|------|------------|
| SDK v0.2.76 has breaking changes | Step 1 bumps first; revert if issues found |
| Multi-file split breaks pi's TypeScript loading | Spike with two-file import test before committing |
| TypeBox-to-JSON-Schema conversion has edge cases | Test with actual pi tool schemas; TypeBox IS JSON Schema by design |
| `strict` mode flags too many existing issues | Enable only `strictNullChecks` + `noImplicitAny`; fix incrementally |
| `.js` import extensions don't work with pi's loader | Spike test first; fallback to single-file if needed |

## Open Questions

1. **Structured tool_result blocks**: The performance oracle identified O(n^2) token growth from prompt replay as the binding constraint. Investigate SDK's `streamInput()` for persistent subprocess to eliminate replay. This would also enable structured `tool_result` blocks. Deferred — significant architectural change.
2. **Pi upstream contributions**: Propose `replaceAll` for pi's edit tool and `pages` for pi's read tool. Would eliminate handler-level workarounds.
3. **TypeBox schema fix approach**: The MCP engineer confirmed TypeBox schemas produce empty schemas. Two options: (a) strip TypeBox wrapper and pass raw JSON Schema properties, (b) convert to Zod at registration. Option (a) is simpler since TypeBox IS JSON Schema. Verify which approach works with the SDK's MCP internals.

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-16-tool-mapping-overhaul-brainstorm.md](docs/brainstorms/2026-03-16-tool-mapping-overhaul-brainstorm.md) — Key decisions carried forward: handler pattern, implement missing tools in pi (deferred), incremental delivery, bump SDK first

### Internal References

- Current tool mapping: `index.ts:12-33` (name maps), `index.ts:374-421` (arg translation)
- Streaming pipeline: `index.ts:551-864`
- MCP setup: `index.ts:461-481`
- Thinking budget workaround: `index.ts:505-516`
- Dead code: `index.ts:276` (`legacyDisable = false`)
- Pi ExtensionAPI: `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`
- SDK tool schemas: `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`

### External References

- Claude Agent SDK docs: https://platform.claude.com/docs/en/agent-sdk/overview
- SDK changelog: https://github.com/anthropics/claude-agent-sdk-typescript/releases
- TypeBox schema issue: https://github.com/anthropics/claude-agent-sdk-typescript/issues/27
- Zod compatibility: https://github.com/anthropics/claude-agent-sdk-typescript/issues/38
- MCP architecture: https://modelcontextprotocol.io/docs/learn/architecture
