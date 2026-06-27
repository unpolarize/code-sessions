# code-sessions

**Headless, event-driven cross-agent session capture.** A standalone agent that  
captures your coding-agent sessions (Claude Code today; Codex/Grok next) turn by  
turn — with telemetry and derived insights — into a **git-backed store** you own.  
It runs headless (no editor required) and interplays with the  
[Code Sessions VSCode extension](https://github.com/unpolarize/code-sessions-vscode),  
which becomes a *reader* of the same store.

> The reframe: today's session viewers **pull** from `~/.claude/projects` into a  
> throwaway cache. code-sessions **pushes** — a daemon owns capture and writes an  
> immutable, conflict-free git store as the source of truth.

## Why

- **List everywhere · review anywhere.** Per-turn records keyed by `host` +  
`session-uuid` sync through a private git repo (`~/.sessions`). Pull on any  
machine, see every session from every machine.
- **Conflict-free by construction.** Immutable, write-once per-turn files +  
host-keyed paths → two machines (or two agents) never write the same file.
- **Telemetry + insights, in your repo.** Tokens, cost, latency; plus pluggable  
insight labeling (Claude / Grok / local Ollama) and a server-free analytics  
rollup you can run in GitHub Actions.

## Architecture

```
Claude Code ──hooks──▶ code-sessions daemon ──▶ ~/.sessions (git: zhirafovod/sessions.git)
              (event)   │  tail JSONL (content)     hosts/<host>/<YYYY-MM>/<uuid>/
                        │  + OTel metrics            session.json · turns/NNNNNN.json
                        │  hygiene: scrub/cap         insights/labels.json · analytics/
                        └─ insights (claude|grok|ollama|fake)
VSCode extension ◀── reads the store / live daemon status
```

Three stacked capture signals, each degrading gracefully:

1. **Hooks** (`SessionStart`/`PostToolUse`/`Stop`/`SubagentStop`) fire the *event*.
2. **JSONL tail** reads the new bytes of the transcript for full *content*.
3. **OTel** metrics (when `CLAUDE_CODE_ENABLE_TELEMETRY=1`) enrich turns with
  cost/latency; otherwise usage is computed from the transcript.

## Packages

| Package                                               | What                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `[@unpolarize/code-sessions-schema](packages/schema)` | Canonical wire schema (zod + JSON Schema) + the Claude normalizer. The contract shared with the VSCode extension. |
| `[@unpolarize/code-sessions](packages/agent)`         | The daemon + CLI + insights + analytics.                                                                          |

## Quickstart

```bash
npm install            # workspaces
npm test               # 161 tests
npm run build          # dist/

# initialize the store and wire Claude Code
node packages/agent/bin/code-sessions.mjs init   --store ~/.sessions --remote git@github.com:zhirafovod/sessions.git
node packages/agent/bin/code-sessions.mjs install-hooks
node packages/agent/bin/code-sessions.mjs start  --store ~/.sessions --push \
     --provider ollama --mode on-stop            # insights on every session end

# one-time import of existing history, then analytics
node packages/agent/bin/code-sessions.mjs backfill
node packages/agent/bin/code-sessions.mjs reindex --provider fake
node packages/agent/bin/code-sessions.mjs analytics
```

## CLI

| Command                     | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `init`                      | Initialize the git-backed store                          |
| `start`                     | Run the capture daemon (foreground)                      |
| `install-hooks`             | Install Claude Code hooks that feed the daemon           |
| `backfill`                  | Import existing `~/.claude/projects` transcripts         |
| `reindex [--since YYYY-MM]` | (Re)derive insights for stored sessions                  |
| `analytics`                 | Compute rollups + digest + static site into `analytics/` |
| `status` / `doctor`         | Inspect the daemon/store / environment checks            |

Flags: `--store --host --remote --push --provider (none\|fake\|claude\|grok\|ollama) --mode (off\|on-stop\|per-turn) --model`.

## Telemetry attribution & enrichment

`export` (and the daemon's on-stop export) ships OTLP traces + metrics enriched with high-cardinality attribution — group by **user / team / department / repository / intent / custom dimensions**, plus a configurable **per-turn category** classified by ollama. Repository is resolved dynamically from the top-most enclosing `.git` (cached). Custom OTLP `headers`, `tracesPath`/`metricsPath`, and an opt-in span `emitContent` toggle let you target any OTLP backend. See **[docs/telemetry-attribution.md](docs/telemetry-attribution.md)** for the config (`attribution.{team,department,custom,teamByRepo}`, `telemetry.{headers,tracesPath,emitContent}`, `insights.{categories,classifyTurns}`) and the emitted attribute reference.

## MVP roadmap

- **MVP-0** — the existing local VSCode viewer (pull-based). *(have)*
- **MVP-1** — this agent: event-driven capture → conflict-free git store; extension reads it.
- **MVP-1.1** — pluggable insights (claude/grok/ollama), on-stop + reindex.Hygiene (non-negotiable)

Secret-scrub, per-turn size cap with content-addressed externalization, and  
batched commits run *at the door* — the Codex multi-GB-rollout lesson. Runtime  
files and large blobs are gitignored; the store stays text and delta-compresses.

## License

MIT
