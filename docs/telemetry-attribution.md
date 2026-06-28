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
- `emitContent` — when true, emit the first user prompt + last assistant reply (and per-turn
  text) as `gen_ai.prompt.*` / `gen_ai.completion.*` span content. **Off by default — message
  content can be sensitive.**
- `emitMetrics` — set false to export traces only.

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
`code_sessions.turn.category` on turn spans.

## Run it

```bash
code-sessions reindex --provider ollama          # derive insights + classify turns
code-sessions export --since 2026-05             # push enriched OTLP to your collector
```

See [`examples/otel-collector/`](../examples/otel-collector/) for a runnable, vendor-neutral
OTel Collector you can point code-sessions at.

## Emitted attribute reference

**Root span** — `session.id`, `gen_ai.conversation.id`, `gen_ai.system`, `gen_ai.agent.name`,
`gen_ai.request.model`, `session.turn_count`, `gen_ai.usage.{input_tokens,output_tokens,cached_input_tokens}`,
`code_sessions.cost_usd`, `project.path`, plus the derived attribution (`gen_ai.conversation.intent`/`.topic`,
`code.repository`, `vcs.repository.url`, `enduser.id`) and your custom association properties under
their own keys + a JSON `metadata` attribute. Optional `gen_ai.prompt.*`/`gen_ai.completion.*`
content when `emitContent` is on.

**Turn span** — `turn.index`, `gen_ai.role`, `gen_ai.usage.*`, `code_sessions.tool_count`,
`code_sessions.cost_usd`, `code_sessions.turn.category` + optional content.

**Metric data points** (`code_sessions.tokens` by `gen_ai.token.type`, `code_sessions.cost_usd`,
`code_sessions.turns`) — `session.id`, `gen_ai.system` + the full attribution set above.

`host.name` rides on the OTLP **resource** for every signal.
