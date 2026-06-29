# GenAI-semconv telemetry for code-sessions

**Status:** approved → implementing · **Date:** 2026-06-29 · **Version target:** agent 0.9.0 (breaking OTLP wire change)

## Goal

Re-model code-sessions telemetry on the OTel GenAI semantic conventions:

- **session / conversation** — a multi-turn chat, correlated across traces by `gen_ai.conversation.id` (the session uuid).
- **turn = trace** — one user request and the agent's work until the next user message; its own `traceId`.
- **invocation = span** — an LLM call (`chat`) or tool call (`execute_tool`) within the turn.

Native OTel from claude/codex is a **trigger**; the **transcript** is adapted into the spans (normalized to semconv where possible, enriched with our existing attributes). Metrics are optional.

## Span model (per turn-trace)

- **Root `invoke_agent <agent>`** — `gen_ai.operation.name=invoke_agent`, `gen_ai.conversation.id`, `gen_ai.agent.name`, `gen_ai.provider.name` (anthropic/openai/xai), `code_sessions.turn.index`, plus enrichment: `enduser.id`, `code.repository`, `vcs.repository.url`, `gen_ai.conversation.intent`/`.topic`, `code_sessions.turn.category`, custom association properties, `host.name` (resource).
  - **`chat <model>`** — `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, cache token attrs, `gen_ai.response.finish_reasons`, `code_sessions.cost_usd`. One per assistant response.
  - **`execute_tool <tool>`** — `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type=function`. One per tool call.

**Token/cost live only on `chat` (leaf) spans.** Session/turn totals = group by `conversation.id` / `traceId`. No rollup span carries totals → the current double-count is designed out.

Trace/span ids are deterministic hashes: `traceId = hash(session_id:turn_index)`, span ids `hash(session_id:turn_index:role:i)` — so re-export is idempotent.

## Components

1. **`telemetry/genai.ts`** — `buildTurnTraces(envelope, turns, attribution, turnCategories, emitContent)` → one OTLP trace payload per turn (resource + scopeSpans). Optional `buildGenaiMetrics(...)` (per-`chat` token/cost data points, opt-in via `telemetry.emitMetrics`). Replaces `buildTracePayload`'s session-as-one-trace shape. Reuses `attributionMap`/`attr` from `otlp.ts`.
2. **`telemetry/exporter.ts`** — emit the per-turn traces (POST each, or one batched payload with multiple resourceSpans) instead of the single session trace.
3. **`telemetry/receiver.ts`** — a minimal OTLP/HTTP receiver (node `http`) the daemon runs on a configurable port. Parses inbound OTLP from claude/codex, extracts `(session.id, conversation.id)` + a "turn happened" signal, and calls back into the daemon to (re)adapt that session. Reconciles authoritative metric values (tokens/cost/latency) onto the synthesized `chat` spans when present.
4. **`daemon.ts`** — own the receiver (start/stop) when `capture.otelTrigger.enabled`; trigger → `captureSession` (Claude) / re-import (codex) → re-export turn-traces. Grok keeps the file-watch trigger.
5. **`config.ts`** — `telemetry.semconv` is the default now; add `capture.otelTrigger.{enabled,port}` (default enabled, `0.0.0.0:4317`-style local). `emitMetrics` stays.
6. **Capture harness** `test/harness/run-capture.sh` + `test/harness/collect.mjs` (file-writing OTLP sink) — checkout 2 OSS repos, 2 users × 2 hosts, run short claude/codex/grok tasks with OTel on, capture native OTel + transcripts → `test/fixtures/real/<agent>/` + manifest, redacted.

## Testing (TDD)

- `genai.test.ts`: canonical `Turn[]` → expected semconv spans (root + chat + execute_tool); **double-count assertions** (Σ `chat` input_tokens == session total; only one chat-bearing turn for codex cumulative); enrichment-by-project/user/host via multi-attribution fixtures; idempotent ids.
- `receiver.test.ts`: inbound OTLP → parsed trigger → adaptation callback invoked with the right session id; metric reconciliation.
- Real fixtures (Phase from harness) replay through the adapter as an integration check.
- Existing suite stays green.

## Sequence

1. Spec (this) → commit.
2. `genai.ts` + tests (red→green).
3. Wire exporter → per-turn traces; bump 0.9.0; update telemetry-attribution.md + architecture.md.
4. `receiver.ts` + tests; wire into daemon + config.
5. Capture harness; run real claude/codex/grok; commit normalized fixtures; replay-test.
6. Full suite + build + typecheck; commit.

## Out of scope

CSV/CB changes (don't read OTLP); backfilling old OTLP consumers; live OTel beyond what claude/codex actually emit.
