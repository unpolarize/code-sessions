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
| **Codex** | ✅ **fires (verified)**, plugin-scoped | a **plugin's** `hooks.json` (marketplace root `<root>/.agents/plugins/marketplace.json` + `<root>/plugins/<name>/`) | per-hook trust; `--dangerously-bypass-hook-trust` | PascalCase (`PostToolUse`) — Claude-compatible |

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

## Codex — plugin built + hooks verified firing

Codex plugins are **user-authorable** (not closed / OpenAI-only): `codex plugin marketplace add`,
`codex plugin add`, and a `plugin-creator` scaffolder ship with the CLI. Hooks are delivered
**inside a plugin's `hooks.json`** (same Claude-style format) — there is **no** user-global hooks
file (`~/.codex/hooks.json` is **not** read).

**Built + shipped:** `integrations/codex-plugin/` — a local marketplace
(`.agents/plugins/marketplace.json`) + the `code-sessions` plugin (`plugins/code-sessions/` with
`.codex-plugin/plugin.json`, `hooks.json`, `scripts/cs-hook.sh`). Install:
`codex plugin marketplace add integrations/codex-plugin && codex plugin add code-sessions@code-sessions-dev`
(or `code-sessions install-hooks --agent codex` prints these). Marketplace root layout: the
manifest lives at `<root>/.agents/plugins/marketplace.json`; plugins at `<root>/plugins/<name>/`.

**Verified (codex-cli 0.142.4):** a real `codex exec` run **fired all five hooks** — SessionStart,
UserPromptSubmit, PreToolUse, PostToolUse, Stop — and the captured payloads are **Claude-style**:
`session_id`, `hook_event_name` (PascalCase value), `transcript_path`, `cwd`, and on tool events
`tool_name`/`tool_input`/`tool_use_id`. **`ipc.parseHookEvent` already handles all of it — no daemon
change was needed for Codex.**

**Delivery constraints found by experiment (why the last mile is finicky):**
- Codex runs a hook `command` as **argv, not through a shell** — use a wrapper *script*
  (`./scripts/cs-hook.sh`), not a shell one-liner (`a; b`).
- Codex's hook process gets a **restricted PATH** (no nvm) — the wrapper resolves `code-sessions`
  from common global-install locations itself.
- `codex exec` runs in a **read-only sandbox** by default, which gates the hook's access to the
  daemon socket; capture needs interactive `codex` or a sandbox that permits it
  (`--dangerously-bypass-approvals-and-sandbox` for exec).
- Requires `code-sessions` on PATH (`npm i -g` / `npm link`) and the daemon running.

So codex is **hook-instrumented at the source** (hooks fire, payload compatible, plugin installs),
with the above deployment constraints. Grok remains the fully-proven end-to-end path.

## Consequence for poller removal (Phase 3 of the migration plan)

- **Grok** can move to hooks now (poller becomes fallback).
- **Codex** hooks fire, but keep the poller until the plugin's hook→daemon delivery is confirmed in
  the user's actual codex sandbox/PATH setup.
- Do **not** gate the watcher off for an agent until its hooks are confirmed delivering — otherwise
  capture silently stops.
