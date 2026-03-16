# Brainstorm: Claude Agent SDK Tool Mapping Overhaul

**Date:** 2026-03-16
**Status:** Draft

## What We're Building

A comprehensive tool mapping overhaul for the `claude-agent-sdk-pi` fork that:

1. **Replaces hardcoded tool mapping** with a registry-based system where each tool has its own handler
2. **Adds missing tools** (WebSearch, WebFetch, Agent/subagents, NotebookEdit, LSP) with pi-side implementations
3. **Fixes argument translation** — current approach guesses multiple field names and fails silently
4. **Ensures bidirectional fidelity** — tool results from pi map back to Claude Code's expected format, including error states and partial results
5. **Improves MCP tool handling** — better namespacing, dynamic registration/deregistration

This is a personal/team-use fork, so we're free to diverge from upstream. It stays pi-only — no host decoupling needed.

## Why This Approach

**Tool Registry Pattern** was chosen over enhanced monolith or typed adapters because:

- Each tool handler is independently testable and deployable
- Adding a new tool = adding a handler, not modifying core logic
- Supports the incremental delivery timeline — ship tool-by-tool
- Natural organization for the 4 concern areas (missing tools, arg translation, result fidelity, MCP)

The current 875-line single file will become harder to maintain as we add 5+ new tool implementations. The registry pattern scales without the file becoming unwieldy.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Tool Registry pattern | Extensible, testable, scales with tool count |
| Missing tool strategy | Implement in pi | Full-featured experience, no hybrid mode |
| Delivery approach | Incremental | Ship tool-by-tool, validate as we go |
| SDK version | Bump to v0.2.76 first | Access new features, isolate upgrade from refactor |
| Testing | From Phase 1b | Tests per handler ensures correctness from the start |

## Scope — Tool Inventory

### Currently Mapped (need fidelity improvements)
- `Read` <-> `read`
- `Write` <-> `write`
- `Edit` <-> `edit`
- `Bash` <-> `bash`
- `Grep` <-> `grep`
- `Glob` <-> `find`/`glob`

### Missing — High Priority
- `WebSearch` — web search capability
- `WebFetch` — fetch and parse web pages
- `Agent` — subagent spawning and orchestration
- `MultiEdit` — batch file edits

### Lower Priority (implement only if needed)
- `TodoWrite` / `TodoRead` — task management
- `NotebookEdit` — Jupyter notebook editing
- `LSP` — Language Server Protocol operations

### MCP Tools (need better handling)
- Dynamic registration/deregistration
- Proper namespacing beyond `mcp__custom-tools__`
- Support for multiple MCP server sources

## Registry Pattern Shape

Each tool handler implements a common interface:

```
ToolHandler {
  sdkName: string           // e.g. "Read"
  piName: string            // e.g. "read"
  translateArgs(sdkArgs) -> piArgs    // SDK arg schema -> pi arg schema
  translateResult(piResult) -> sdkResult  // pi result -> SDK expected format
  handleError(error) -> sdkError         // normalize errors to SDK format
}
```

The registry holds all handlers and provides lookup by either name. The streaming pipeline calls `registry.get(toolName)` instead of inline switch/if chains.

## Incremental Delivery Order

1. **Phase 1a:** Bump SDK to `v0.2.76`, verify existing functionality works
2. **Phase 1b:** Refactor existing 6 tools into registry pattern + fix arg translation + add tests per handler
3. **Phase 2:** Add WebSearch and WebFetch (investigate pi's HTTP capabilities first)
4. **Phase 3:** Add Agent/subagent support (spike on architecture first)
5. **Phase 4:** Improve MCP tool handling
6. **Phase 5:** Add MultiEdit + remaining tools as needed

## Resolved Questions

1. **Pi's extension API surface**: Unknown — needs investigation during Phase 2. Will call external APIs directly (node fetch) if pi doesn't expose native HTTP capabilities.
2. **Subagent model**: Needs exploration — this is the hardest part. Will investigate during Phase 3 whether separate `query()` calls, pi-native tasks, or another model works best.
3. **SDK version pinning**: Bump to latest `v0.2.76` as part of Phase 1 before refactoring. Gets us access to new features and fixes upfront.
4. **Testing strategy**: Tests from Phase 1. Write tests for each tool handler as we build them to ensure correctness from the start.

## Open Questions

_(None remaining — all resolved through brainstorming.)_
