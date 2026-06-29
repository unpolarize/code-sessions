# code-sessions architecture

How session telemetry flows from a coding agent into the store and out as OTLP — what
each agent emits, how it's enriched, what's produced, and where token/cost counts live
(so you don't double-count them).

```
 coding agent                 code-sessions                         outputs
┌──────────────┐  push/pull  ┌──────────────────────────┐        ┌────────────────────────┐
│ Claude Code  │──hooks────▶ │ capture: tail JSONL →     │──────▶ │ git store ~/.sessions   │
│ Codex / Grok │──watch(poll)│   normalize → cost →      │        │  session.json (envelope)│
│ Code Build   │──import──── │   hygiene → write turns   │        │  turns/NNNNNN.json      │
└──────────────┘             │ enrich: identity·project· │        │  insights/labels.json   │
   (transcripts)             │   intent·category·custom  │──────▶ │ SQLite index (.daemon)  │
                             │ export: OTLP traces+metrics│──────▶ │ OTLP collector / vendor │
                             └──────────────────────────┘        │ analytics/ (rollup+site)│
                                                                  └────────────────────────┘
```

The store (`~/.sessions`) is the source of truth; the SQLite index, analytics site, and
OTLP export are all projections of it.

---

## 1. Telemetry inputs (what each agent emits, and how it arrives)

code-sessions does **not** consume an agent's own OpenTelemetry stream. The single input is
each agent's **session transcript on disk**; usage/cost/timing are parsed (or computed) from
it. (`CLAUDE_CODE_ENABLE_TELEMETRY`-style live OTel ingestion is **not** implemented.)

| Agent | Source on disk | Transport into the daemon | What the transcript carries |
|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<enc-cwd>/<uuid>.jsonl` | **Push** — hooks (`SessionStart`/`PostToolUse`/`Stop`/`SubagentStop`) fire an event over a unix socket; the daemon tails the new bytes (`capture.ts`, `tail.ts`) | per-message `usage` (input/output, `cache_read_input_tokens`, `cache_creation_input_tokens`), text, tool calls, model, cwd, git branch, timestamps |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | **Pull** — daemon source watcher polls on an interval (`watcher.ts`), or `backfill --agent codex` | `event_msg` user/agent messages, `response_item` function calls, and a **cumulative** `token_count.total_token_usage` |
| **Grok CLI** | `~/.grok/sessions/<enc-cwd>/<uuid>/{chat_history.jsonl,summary.json,signals.json}` | **Pull** — source watcher / `backfill --agent grok` | user/assistant/tool events + title/model/dates. **No per-turn token usage** is available, so usage is 0 in the CS store |
| **Code Build** | codebuild-jsonl export | `backfill --agent codebuild` | folded user/assistant turns with per-result `usage {inputTokens, outputTokens, cache_read_tokens, costUsd}` |

Hooks are **control** signals (they say *a turn happened*); the JSONL tail is the **content**.
Codex/Grok can't push hooks, so the daemon polls their dirs with `(mtime, size)` dedup.

Normalization (`packages/schema/src/normalize.ts`) maps each agent's usage onto one canonical
`Usage` shape — `{ input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }`
(`cache_read_input_tokens → cache_read_tokens`, `cache_creation_input_tokens → cache_write_tokens`).

---

## 2. Enrichment (per dimension, where it's computed)

Enrichment is additive and computed locally — none of it comes from the agent.

| Dimension | How it's derived | Where |
|---|---|---|
| **Cost (`cost_usd`)** | `tokens × list-price ÷ 1e6`, model matched by substring; attached per assistant turn as `telemetry.cost_usd`. Code Build carries its own `costUsd`; Grok has no tokens → no cost. | `pricing.ts`, `capture.ts:62` |
| **Identity (`enduser.id`)** | git `user.email` → `user.name` → OS user, overridable by `attribution.enduser` | `telemetry/identity.ts` |
| **Project (`code.repository`)** | dominant git repo for the session = the top-most enclosing `.git` of the files it edited; label `org/repo` from the `origin` remote (else dir name); resolution cached per directory | `insights/repo.ts` |
| **Intent / topic** | insights labeler (heuristics or a provider) → `insights/labels.json` | `insights/` |
| **Per-turn category** | local **ollama** classifier maps each turn to a configured taxonomy | `insights/classifier.ts` |
| **Custom association properties** | `attribution.custom` (global) merged with `attribution.customByRepo[<project>]` (per-project) | `telemetry/attribution.ts` |
| **Hygiene** (not enrichment, but in-path) | secret-scrub + per-turn size cap with content-addressed externalization, before write | `hygiene.ts` |

See [`telemetry-attribution.md`](telemetry-attribution.md) for the attribution config + the
full emitted-attribute reference.

---

## 3. Outputs

1. **Git store** `~/.sessions/hosts/<host>/<YYYY-MM>/<uuid>/` — `session.json` (the **envelope**,
   whose `totals` are the sum of per-turn usage/cost), `turns/NNNNNN.json` (immutable per-turn),
   `insights/labels.json`. Conflict-free (host-keyed, write-once).
2. **SQLite index** `~/.sessions/.daemon/index.db` — a projection for `query` / `search` /
   `usage` / `graph` / `analytics`.
3. **Analytics** — rollup + digest + static site under `analytics/`.
4. **OTLP export** (OTel **GenAI** semantic conventions, `telemetry/genai.ts`) — `export` (and the
   daemon's on-stop export) POST OTLP/HTTP JSON to any OTel-compatible backend:
   - **Traces — turn = trace.** Each conversational turn is its own trace, correlated to its session
     by `gen_ai.conversation.id`. Per turn: an **`invoke_agent`** root span (agent + all enrichment),
     one child **`chat`** span per LLM response (`gen_ai.request.model`, `gen_ai.usage.*`,
     `code_sessions.cost_usd`), and one child **`execute_tool`** span per tool call
     (`gen_ai.tool.name`/`.call.id`).
   - **Metrics — optional** (`telemetry.emitMetrics`, off by default): `gen_ai.client.token.usage`
     (Sum, one point per `chat` × token type) + `code_sessions.cost_usd` (Sum). `host.name` on the
     OTLP resource.

---

## 4. Counting model & double-counting analysis

### The levels (OTel GenAI semconv)

- **session / conversation** — a set of traces correlated by `gen_ai.conversation.id`. Not a span.
- **turn = trace** — one trace per conversational turn (its own `traceId`).
- **invocation = span** — the `chat` (LLM) and `execute_tool` (tool) spans inside a turn, parented
  to an `invoke_agent` root span.

**Token/cost usage lives ONLY on the leaf `chat` spans.** The `invoke_agent` root carries no totals,
so there is no rollup to double-count. Session/turn aggregates come from grouping spans by
`gen_ai.conversation.id` / `traceId`.

### Double-counting status

| Surface | Status |
|---|---|
| **Within a trace** (root vs leaves) | **Eliminated by design.** Only `chat` spans carry `gen_ai.usage.*`; `Σ chat input_tokens == session total`. `invoke_agent`/`execute_tool` carry no token totals, so summing all spans in a trace does not double-count. |
| **Across signals** (trace ↔ metric) | The optional `gen_ai.client.token.usage` metric mirrors the `chat`-span usage (same per-`chat` data points). Aggregate from **either** the `chat` spans **or** the metric — **never both**. Metrics are off by default to avoid the trap. |
| **Re-export** of a session | **Idempotent.** Trace/span ids are deterministic hashes of `(session_id, turn_index, …)`, so a re-export overwrites rather than appends on id-keyed backends. Only a count-on-each-receipt pipeline double-counts — dedup by `conversation.id` or export once. |
| **Duplicate attribute keys** | **Gone.** Each enrichment key is set once on the `invoke_agent` root; the old `attributionAttrs` rollup that duplicated `code_sessions.cost_usd`/`gen_ai.system` is retired. |

### Per-agent notes

- **Codex** reports a *cumulative* `token_count`; the adapter attributes it to the **final assistant
  turn only** (`adapters/codex.ts`), so exactly one `chat` span carries the total and `Σ chat ==
  session total`.
- **Grok** carries **no token usage** → its `chat` spans report 0 (a coverage gap, not a correctness
  issue).
- **Tool calls** are real `execute_tool` spans now, but carry no token usage, so they never
  contribute to token/cost sums.

### Rule of thumb

> Aggregate tokens/cost by **summing the `chat` spans** (group by `gen_ai.conversation.id` for a
> session total, by `traceId` for a turn). If you enable metrics, use those *instead* — never add the
> two. `invoke_agent` and `execute_tool` spans are structure/enrichment, not usage.
