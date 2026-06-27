# Telemetry ingestion setup

How to stand up a receiver for the enriched OTLP that `code-sessions export` emits, and query
the attribution dimensions (by user / team / department / repository / intent / custom +
per-turn category). See [`../../docs/telemetry-attribution.md`](../../docs/telemetry-attribution.md)
for what the attributes mean and how to configure them.

## What code-sessions sends

`code-sessions export` (and the daemon's on-stop export) POSTs **OTLP/HTTP JSON** to
`OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`) on `/v1/traces` and
`/v1/metrics`. Any OTLP-compatible collector/backend works; this example uses the
OpenTelemetry Collector → ClickHouse (a generic OLAP backend) so you can run group-by queries.

## Option A — instant sanity check (no database)

```bash
# edit config.yaml: drop `clickhouse` from the two `exporters:` lists, leaving only `debug`
docker run --rm -p 4318:4318 -p 4317:4317 \
  -v "$PWD/examples/otel-collector/config.yaml:/etc/otel/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.111.0 --config=/etc/otel/config.yaml

# in another shell — point code-sessions at it and push the store
CODE_SESSIONS_TELEMETRY=1 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  node packages/agent/bin/code-sessions.mjs export --since 2026-05
```

You should see `session …` spans (with `enduser.id`, `code.repository`, `organization.team`,
`gen_ai.conversation.intent/topic`, your `custom` keys) and `code_sessions.tokens` /
`code_sessions.cost_usd` metrics in the collector log.

## Option B — queryable stack (Collector + ClickHouse)

```bash
docker compose -f examples/otel-collector/docker-compose.yaml up -d
node packages/agent/bin/code-sessions.mjs reindex --provider ollama   # populate intent/topic/categories
CODE_SESSIONS_TELEMETRY=1 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  node packages/agent/bin/code-sessions.mjs export --since 2026-05
```

The ClickHouse exporter auto-creates `otel.otel_traces` and `otel.otel_metrics_*` tables.

### Example queries

```sql
-- cost by user + repo (from the cost gauge metric)
SELECT Attributes['enduser.id'] AS user,
       Attributes['code.repository'] AS repo,
       round(sum(Value), 4) AS cost_usd
FROM otel.otel_metrics_gauge
WHERE MetricName = 'code_sessions.cost_usd'
GROUP BY user, repo ORDER BY cost_usd DESC;

-- tokens by team and token type
SELECT Attributes['organization.team'] AS team,
       Attributes['gen_ai.token.type'] AS token_type,
       sum(Value) AS tokens
FROM otel.otel_metrics_sum
WHERE MetricName = 'code_sessions.tokens'
GROUP BY team, token_type ORDER BY tokens DESC;

-- per-turn category breakdown (from turn spans)
SELECT SpanAttributes['code_sessions.turn.category'] AS category, count() AS turns
FROM otel.otel_traces
WHERE SpanAttributes['code_sessions.turn.category'] != ''
GROUP BY category ORDER BY turns DESC;
```

(Exact table/column names follow the ClickHouse exporter's schema for collector-contrib
0.111.0; adjust if you pin a different version.)

## Other backends

The same `otlp` receiver fans out to any exporter — swap `clickhouse` for `prometheusremotewrite`
(metrics) + `otlp` to a trace store (Grafana Tempo), or an `otlphttp` exporter to any vendor.
Set custom routes/auth via `telemetry.{tracesPath,metricsPath,headers}` in `~/.sessions/config.json`.

## Disable / point elsewhere

- `CODE_SESSIONS_TELEMETRY=0` — disable export.
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://host:4318` — send to a remote collector.
- `CODE_SESSIONS_OTLP_HEADERS='{"Authorization":"Bearer …"}'` — extra headers.
- Or set `telemetry.{enabled,endpoint,tracesPath,metricsPath,headers,emitContent}` in config.
