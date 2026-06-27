# Telemetry attribution & enrichment

The OTLP exporter (`code-sessions export`, plus the daemon's on-stop export) enriches every
session's traces + metrics with high-cardinality **attribution** so any OTLP backend can
break activity down by **user / team / department / repository / intent / custom dimensions**,
and tag each turn with a **category** from a taxonomy you define.

Everything here is opt-in and additive — with no config you get standard OTLP telemetry, plus
repo/identity resolved from git where available.

## Where attribution comes from

| Dimension | OTel attribute | Source |
| --- | --- | --- |
| Repository | `code.repository`, `vcs.repository.url` | **dynamic git-root resolution** — top-most enclosing `.git` of the files a session touched; labelled `org/repo` from the `origin` remote, else the dir name. Cached per directory. |
| Intent / topic | `gen_ai.conversation.intent` / `.topic` | `insights/labels.json` (heuristics or the configured insights provider) |
| User | `enduser.id` | config override → git `user.email` → git `user.name` → OS user |
| Team / department | `organization.team` / `organization.department` | per-repo map → static config |
| Custom | *your keys* | `attribution.custom` (verbatim) |
| Per-turn category | `code_sessions.turn.category` (turn spans) | the per-turn classifier |

These ride on the **root span**, on **every metric data point**, and as a single JSON
`metadata` attribute (some backends fold that into one groupable column).

## Configure attribution

In `~/.sessions/config.json`:

```json
{
  "attribution": {
    "enduser": "you@example.com",
    "team": "platform",
    "department": "engineering",
    "teamByRepo": {
      "acme/api": { "team": "payments", "department": "fintech" }
    },
    "custom": { "cost.center": "CC-1", "env": "dev", "tenant.id": "acme" }
  }
}
```

`enduser` is optional (auto-resolved from git/OS); `teamByRepo` keys are the resolved
`org/repo` label; `custom` keys are emitted verbatim — use any OTLP-valid key.

## Targeting an OTLP backend

`telemetry` accepts generic routing so you can point at any collector or vendor endpoint:

```json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "https://otlp.example.com",
    "tracesPath": "/v1/traces",
    "metricsPath": "/v1/metrics",
    "headers": { "Authorization": "Bearer …" },
    "emitContent": false,
    "emitMetrics": true
  }
}
```

- `tracesPath` / `metricsPath` — override the default OTLP paths for backends with custom routes.
- `headers` — extra HTTP headers on every export (auth / tenancy / routing). Also via
  `CODE_SESSIONS_OTLP_HEADERS='{"Authorization":"Bearer …"}'`.
- `emitContent` — when true, emit the first user prompt + last assistant reply (and per-turn
  text) as `gen_ai.prompt.*` / `gen_ai.completion.*` span content. **Off by default — message
  content can be sensitive.**
- `emitMetrics` — set false to export traces only.

## Per-turn category classifier

Each turn is classified into one of a taxonomy you define, via the local **ollama** classifier
(one batched call per session; degrades to no categories if ollama is unreachable):

```json
{
  "insights": {
    "provider": "ollama", "mode": "on-stop",
    "categories": ["coding", "debugging", "planning", "research", "review", "ops"],
    "classifyTurns": true, "classifierModel": "llama3.1"
  }
}
```

`CODE_SESSIONS_CATEGORIES="coding,debugging,planning"` sets `categories` and enables
classification in one go. Stored in `insights/labels.json` (`turn_categories`), emitted as
`code_sessions.turn.category` on turn spans.

## Run it

```bash
code-sessions reindex --provider ollama          # derive insights + classify turns
code-sessions export --since 2026-05             # push enriched OTLP to your collector
```

See [`examples/otel-collector/`](../examples/otel-collector/) for a runnable OTel Collector
(+ ClickHouse) and example group-by queries.

## Emitted attribute reference

**Root span** — `session.id`, `gen_ai.conversation.id`, `gen_ai.system`, `gen_ai.agent.name`,
`gen_ai.request.model`, `session.turn_count`, `gen_ai.usage.{input_tokens,output_tokens,cached_input_tokens}`,
`code_sessions.cost_usd`, `project.path` + attribution (`gen_ai.conversation.intent`/`.topic`,
`code.repository`, `vcs.repository.url`, `enduser.id`, `organization.team`/`.department`, custom
keys) + a JSON `metadata` attribute. Optional `gen_ai.prompt.*`/`gen_ai.completion.*` content
when `emitContent` is on.

**Turn span** — `turn.index`, `gen_ai.role`, `gen_ai.usage.*`, `code_sessions.tool_count`,
`code_sessions.cost_usd`, `code_sessions.turn.category` + optional content.

**Metric data points** (`code_sessions.tokens` by `gen_ai.token.type`, `code_sessions.cost_usd`,
`code_sessions.turns`) — `session.id`, `gen_ai.system` + the full attribution set above.
