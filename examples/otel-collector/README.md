# Telemetry ingestion setup

How to stand up a receiver for the enriched OTLP that `code-sessions export` emits. It works
with **any OTel-compatible telemetry provider** — this example uses a vendor-neutral
OpenTelemetry Collector so you can see the data without committing to a backend, then forward it
wherever you like. See [`../../docs/telemetry-attribution.md`](../../docs/telemetry-attribution.md)
for what the attributes mean and how to configure the custom association properties.

## What code-sessions sends

`code-sessions export` (and the daemon's on-stop export) POSTs **OTLP/HTTP JSON** to
`OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`) on `/v1/traces` and
`/v1/metrics`. Any OTLP-compatible collector or backend works.

## Instant sanity check

```bash
docker run --rm -p 4318:4318 -p 4317:4317 \
  -v "$PWD/examples/otel-collector/config.yaml:/etc/otel/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.111.0 --config=/etc/otel/config.yaml

# in another shell — point code-sessions at it and push the store
CODE_SESSIONS_TELEMETRY=1 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  node packages/agent/bin/code-sessions.mjs export --since 2026-05
```

The collector log (the `debug` exporter) prints every `session …` span — carrying the derived
attributes (`host.name`, `enduser.id`, `code.repository`, `gen_ai.conversation.intent/topic`) and
your custom association properties — plus the `code_sessions.tokens` / `code_sessions.cost_usd`
metrics. Populate intent/topic/categories first with:

```bash
node packages/agent/bin/code-sessions.mjs reindex --provider ollama
```

## Forward to a real backend

Edit [`config.yaml`](config.yaml) and uncomment the `otlphttp` exporter (add it to the `traces`
and `metrics` pipelines) to forward to any OTel-compatible vendor or your own collector/store.
The same `otlp` receiver can fan out to any exporter the collector-contrib build supports. Set
custom routes/auth on the code-sessions side via `telemetry.{tracesPath,metricsPath,headers}` in
`~/.sessions/config.json`.

## Disable / point elsewhere

- `CODE_SESSIONS_TELEMETRY=0` — disable export.
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://host:4318` — send to a remote collector.
- `CODE_SESSIONS_OTLP_HEADERS='{"Authorization":"Bearer …"}'` — extra headers.
- Or set `telemetry.{enabled,endpoint,tracesPath,metricsPath,headers,emitContent}` in config.
