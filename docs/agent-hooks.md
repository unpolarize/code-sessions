# Agent hook support (Claude / Codex / Grok)

Empirical research + experiments (2026-07-01) into whether each coding agent can drive
code-sessions capture via lifecycle hooks, and the exact config each needs. This decides
whether the poll-based `SourceWatcher` can be retired per agent (it can't be, safely, until
hooks are *confirmed* for that agent).

## Summary

| Agent | Hookable? | Where hooks live | Trust | Event-name case |
|---|---|---|---|---|
| **Claude** | ✅ (in use) | `~/.claude/settings.json` | n/a | PascalCase (`PostToolUse`) |
| **Grok** | ✅ **verified live** | `~/.grok/hooks/*.json` (global, always-trusted); also reads `~/.claude/settings.json` by default | global trusted; project needs `/hooks-trust` | **snake_case** (`post_tool_use`) |
| **Codex** | ⚠️ plugin-scoped | a **plugin's** `hooks.json` (via `.agents/plugins` marketplace) | per-hook trust; `--dangerously-bypass-hook-trust` | PascalCase (config keys) |

## Grok — verified

Global hooks in `~/.grok/hooks/*.json` use the **exact Claude-style document**
(`{ hooks: { <Event>: [{ hooks: [{ type: "command", command }] }] } }`) and are always trusted.
A live `grok -p` run fired `session_start`, `pre_tool_use`, `post_tool_use`, `stop` at our probe.

**Gotcha (fixed):** grok's stdin `hookEventName` is **snake_case** (`post_tool_use`), not
PascalCase — and camelCase field names (`sessionId`, `toolName`, `toolInput`, `toolUseId`,
`transcriptPath`). `ipc.ts:canonicalHookEvent` now normalizes the event name to PascalCase and
`parseHookEvent` maps the camelCase fields, so grok events flow through the same lifecycle
handling as Claude. Grok payloads are also **richer** — they include `toolResult` and
`effectiveToolName`.

Grok's event set is a superset of Claude's: adds `PostToolUseFailure`, `PermissionDenied`,
`StopFailure`, `SubagentStart`, `PreCompact`, `PostCompact`, `SessionEnd`.

**Install:** `code-sessions install-hooks --agent grok` → writes `~/.grok/hooks/code-sessions.json`
pointing at `code-sessions hook`. **Validated end-to-end**: a real grok session drove the daemon
through hooks → all five real-time OTel log events (`code_sessions.session.start`, `.turn.prompt`,
`.tool.decision`, `.tool.result`, `.session.end`) landed at `/v1/logs`.

## Codex — plugin-scoped (not yet wired)

Codex *has* a hook system (`--dangerously-bypass-hook-trust`, per-project `trust_level` in
`~/.codex/config.toml`), but hooks are delivered **inside plugins** (a plugin dir's `hooks.json`,
same Claude-style format), installed through the codex plugin marketplace
(`.agents/plugins/marketplace.json`). There is **no** simple user-global hooks file: a probe at
`~/.codex/hooks.json` was **not** read.

So wiring Codex to hooks requires **packaging + installing a small code-sessions codex plugin**
whose `hooks.json` runs `code-sessions hook`. Until that's built and confirmed, Codex stays on the
`SourceWatcher` poll path (which is verified working). This is the remaining piece for
"hooks completely."

## Consequence for poller removal (Phase 3 of the migration plan)

- **Grok** can move to hooks now (poller becomes fallback).
- **Codex** must keep the poller until a codex plugin is shipped + verified.
- Do **not** gate the watcher off for an agent until its hooks are confirmed installed — otherwise
  capture silently stops.
