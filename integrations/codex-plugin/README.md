# code-sessions — Codex plugin

Forwards Codex lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `Stop`, `SubagentStop`) to the `code-sessions` daemon so Codex sessions are
captured and emit real-time OTel signals — the same hook contract as Claude/Grok.

## Install

```bash
# from the code-sessions repo root
codex plugin marketplace add integrations/codex-plugin
codex plugin add code-sessions@code-sessions-dev
# or: code-sessions install-hooks --agent codex   (does the two steps above)
```

`code-sessions` must be on PATH (e.g. `npm i -g @unpolarize/code-sessions`, or `npm link`
in `packages/agent`). The daemon must be running (`code-sessions start`) for capture; the
hook is a silent no-op otherwise.

## Verified / constraints (2026-07-02, codex-cli 0.142.4)

- **Codex fires all lifecycle hooks** ✅ and its payload is Claude-style (`session_id`,
  `hook_event_name` PascalCase, `transcript_path`, `cwd`, `tool_name`/`tool_input`/`tool_use_id`)
  — already handled by `ipc.parseHookEvent`, no daemon change needed.
- Codex runs hook commands as **argv (no shell)** — use a wrapper script, not a shell one-liner.
- Codex hooks get a **restricted PATH** (no nvm) — the wrapper resolves the binary itself.
- `codex exec` runs in a **read-only sandbox** by default; capture needs the hook to reach the
  daemon socket (interactive `codex`, or a sandbox that permits it).
