# Telemetry attribution & enrichment

The OTLP exporter (`code-sessions export`, plus the daemon's on-stop export) enriches every
session's traces + metrics with **custom association properties** so any OTel-compatible
backend can slice activity however you choose, and tags each turn with a **category** from a
taxonomy you define.

Everything here is opt-in and additive — with no config you still get standard OTLP telemetry
plus the attributes the exporter derives on its own.

## What the exporter derives on its own

You don't have to configure these — they come from the environment:

| Attribute | Source |
| --- | --- |
| `host.name` | the machine the session ran on (the store's `host`) |
| `enduser.id` (the **user**) | git `user.email` → git `user.name` → OS user |
| `code.repository` / `vcs.repository.url` (the **project**) | derived from git — see below |
| `gen_ai.conversation.intent` / `.topic` | the insights labeler (`insights/labels.json`) |
| `code_sessions.turn.category` | the per-turn classifier (turn spans) |

### How the project is derived

The exporter resolves each session's **project** from git rather than from any path convention:

1. For the files a session edited (and its working directory), it walks up the directory tree to
   the **top-most enclosing `.git` work-tree root** (outermost, so nested submodules/worktrees
   attribute to the umbrella project).
2. The project **label** is `org/repo` parsed from the `origin` remote URL; with no remote it
   falls back to the root directory's name.
3. The session's project is the one with the most edits across its turns (ties break toward the
   working directory's project). Resolution is cached per directory, so a session touching
   thousands of paths costs at most one `.git` stat per directory.

## Custom association properties

On top of the derived attributes you can attach arbitrary key/value **association properties**,
emitted verbatim on every span and metric data point. Configure them in `~/.sessions/config.json`:

```json
{
  "attribution": {
    "custom": {
      "cost.center": "CC-1042",
      "env": "dev",
      "tenant.id": "acme"
    }
  }
}
```

### Per-project association properties

Set properties that apply only when a session's derived project matches a given label. Per-project
values are merged **over** the global `custom` ones, so you can set a global default and override it
per project. The key is the resolved project label (`org/repo`, or the directory name):

```json
{
  "attribution": {
    "enduser": "you@example.com",
    "custom": { "env": "dev" },
    "customByRepo": {
      "acme/api": { "env": "prod", "tier": "backend" },
      "acme/web": { "tier": "frontend" }
    }
  }
}
```

- `enduser` — optional; overrides the derived git/OS identity.
- `custom` — global association properties (any OTLP-valid key → string value).
- `customByRepo` — per-project association properties, keyed by the resolved project label.

## Targeting an OTel-compatible backend

`telemetry` accepts generic routing so you can point at any OTel collector or vendor endpoint:

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
- `emitContent` — when true, emit the user prompt / assistant reply as `gen_ai.input.messages` /
  `gen_ai.output.messages` span content. **Off by default — message content can be sensitive.**
- `emitMetrics` — set **true** to *additionally* export GenAI metrics. **Off by default** (the
  trace `chat` spans already carry usage; aggregate from one signal, not both).

## Per-turn category classifier

Each turn is classified into one of a taxonomy you define, via a local **ollama** classifier
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
`code_sessions.turn.category` on the turn's `invoke_agent` + `chat` spans.

## Run it

```bash
code-sessions reindex --provider ollama          # derive insights + classify turns
code-sessions export --since 2026-05             # push enriched OTLP to your collector
```

See [`examples/otel-collector/`](../examples/otel-collector/) for a runnable, vendor-neutral
OTel Collector you can point code-sessions at.

## Emitted attribute reference (GenAI semconv)

The model is **turn = trace, invocation = span** — one trace per conversational turn, correlated
across a session by `gen_ai.conversation.id`. See [`architecture.md`](architecture.md) for the
counting model.

**`invoke_agent` span (turn root)** — `gen_ai.operation.name=invoke_agent`, `gen_ai.conversation.id`,
`gen_ai.agent.name`, `gen_ai.provider.name` (anthropic/openai/xai), `code_sessions.turn.index`, plus
the derived + custom attribution (`enduser.id`, `code.repository`, `vcs.repository.url`,
`gen_ai.conversation.intent`/`.topic`, `code_sessions.turn.category`, your custom association
properties). Optional `gen_ai.input.messages` content when `emitContent` is on. **Carries no token
totals** (no rollup).

**`chat` span (LLM invocation, child of the root)** — `gen_ai.operation.name=chat`,
`gen_ai.request.model`, `gen_ai.usage.{input_tokens,output_tokens,cache_read_tokens,cache_write_tokens}`,
`code_sessions.cost_usd`, `code_sessions.turn.category`. Optional `gen_ai.output.messages` when
`emitContent` is on. **Token/cost live only here.**

**`execute_tool` span (tool invocation, child of a chat span)** — `gen_ai.operation.name=execute_tool`,
`gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`.

**Optional metrics** (`emitMetrics: true`) — `gen_ai.client.token.usage` (Sum, one point per `chat`
× `gen_ai.token.type`) and `code_sessions.cost_usd` (Sum), each keyed by `gen_ai.conversation.id` +
`code_sessions.turn.index` + the attribution set.

`host.name` rides on the OTLP **resource** for every signal.
