# Telemetry capture harness

Tools to produce **real**, normalized, redacted telemetry fixtures for the GenAI-semconv
adapter (`packages/agent/src/telemetry/genai.ts`), and to capture fresh agent telemetry.

## `make-fixtures.mts` — redacted fixtures from on-disk sessions (committed corpus)

```bash
npx tsx test/harness/make-fixtures.mts [countPerAgent=2]
```

Reads real Claude / Codex / Grok sessions already on disk, normalizes them through the
production adapters, **whitelists only the fields the adapter needs** (roles, usage, tool
names, timing), and writes `test/fixtures/real/<agent>/<id>.json`. All free text → `<redacted
len=N>`, tool inputs dropped, project paths anonymized to `/work/project-*`, titles redacted.
The committed fixtures drive `genai-replay.test.ts`.

> Re-run after changing the schema or adapters. **Verify no leakage** before committing:
> `grep -rIE 'zhirafovod|/Users/|@gmail|Splunk' test/fixtures/real` must be empty.

## `otlp-sink.mjs` — file-writing OTLP sink

```bash
SINK_OUT=./cap/otel SINK_PORT=4318 node test/harness/otlp-sink.mjs
```

Writes each received OTLP/HTTP export to `<SINK_OUT>/<signal>.jsonl`. Verified to capture real
Claude Code telemetry (`claude_code.token.usage`, `…cost.usage`, logs) carrying the `session.id`
the daemon's receiver triggers on.

## `run-capture.sh` — fresh runs across projects × identities

```bash
bash test/harness/run-capture.sh [CAPTURE_DIR]
```

Sets up two git projects (shallow OSS clones, local fallback) and two identities/hosts
(`alice@…/alice-mbp`, `bob@…/bob-mini`), starts the sink, and runs short tasks via the actual
`claude` / `codex` / `grok` CLIs with OTel enabled — capturing native OTel **and** transcripts.
Requires the CLIs installed + authed. **Redact with `make-fixtures.mts` before committing
anything from the capture dir.**

### Live wiring (daemon uses the agents' telemetry as a trigger)

```bash
code-sessions start    # enable capture.otelTrigger in ~/.sessions/config.json first
CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp \
  OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  claude -p "…"        # the daemon receiver sees session.id and re-emits GenAI-semconv traces
```
