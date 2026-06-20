import { createHash } from 'node:crypto';
import type { SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';

/**
 * Minimal OTLP/HTTP JSON exporter — emits standard OpenTelemetry traces +
 * metrics for captured sessions to any OTLP collector, with no SDK dependency.
 * One trace per session (root span + a child span per turn) + token/cost metrics.
 */

type AnyValue =
  | { stringValue: string }
  | { intValue: number }
  | { doubleValue: number }
  | { boolValue: boolean };

interface KeyValue {
  key: string;
  value: AnyValue;
}

function attr(key: string, value: string | number | boolean): KeyValue {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  return Number.isInteger(value)
    ? { key, value: { intValue: value } }
    : { key, value: { doubleValue: value } };
}

function hexId(input: string, bytes: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, bytes * 2);
}

/** ISO-8601 → unix nanoseconds as a string (avoids float precision loss). */
export function isoNano(ts: string | undefined): string {
  if (!ts) return '0';
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? '0' : `${ms}000000`;
}

const SCOPE = { name: 'code-sessions', version: '0.1.0' };

function resource(serviceName: string, host: string): { attributes: KeyValue[] } {
  return {
    attributes: [
      attr('service.name', serviceName),
      attr('host.name', host),
      attr('telemetry.sdk.name', 'code-sessions'),
      attr('telemetry.sdk.language', 'nodejs'),
    ],
  };
}

function sumUsage(turns: Turn[]) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const t of turns) {
    u.input += t.usage.input_tokens;
    u.output += t.usage.output_tokens;
    u.cacheRead += t.usage.cache_read_tokens;
    u.cacheWrite += t.usage.cache_write_tokens;
    u.cost += t.telemetry?.cost_usd ?? 0;
  }
  return u;
}

export function buildTracePayload(
  session: SessionEnvelope,
  turns: Turn[],
  serviceName: string,
): unknown {
  const traceId = hexId(session.session_id, 16);
  const rootId = hexId(`${session.session_id}:root`, 8);
  const totals = sumUsage(turns);

  const rootSpan = {
    traceId,
    spanId: rootId,
    name: `session ${session.title ?? session.session_id}`,
    kind: 1,
    startTimeUnixNano: isoNano(session.started_at),
    endTimeUnixNano: isoNano(session.ended_at ?? session.started_at),
    attributes: [
      attr('session.id', session.session_id),
      attr('gen_ai.system', session.agent),
      ...(session.model ? [attr('gen_ai.request.model', session.model)] : []),
      attr('session.turn_count', session.turn_count),
      attr('gen_ai.usage.input_tokens', totals.input),
      attr('gen_ai.usage.output_tokens', totals.output),
      attr('code_sessions.cost_usd', Math.round(totals.cost * 1e6) / 1e6),
      ...(session.project_path ? [attr('project.path', session.project_path)] : []),
    ],
    status: {},
  };

  const turnSpans = turns.map((t) => ({
    traceId,
    spanId: hexId(`${session.session_id}:${t.turn_index}`, 8),
    parentSpanId: rootId,
    name: `turn ${t.turn_index} ${t.role}`,
    kind: 1,
    startTimeUnixNano: isoNano(t.ts),
    endTimeUnixNano: isoNano(t.ts),
    attributes: [
      attr('turn.index', t.turn_index),
      attr('gen_ai.role', t.role),
      attr('gen_ai.usage.input_tokens', t.usage.input_tokens),
      attr('gen_ai.usage.output_tokens', t.usage.output_tokens),
      attr('code_sessions.tool_count', t.tool_calls.length),
      attr('code_sessions.cost_usd', t.telemetry?.cost_usd ?? 0),
    ],
    status: {},
  }));

  return {
    resourceSpans: [
      {
        resource: resource(serviceName, session.host),
        scopeSpans: [{ scope: SCOPE, spans: [rootSpan, ...turnSpans] }],
      },
    ],
  };
}

export function buildMetricPayload(
  session: SessionEnvelope,
  turns: Turn[],
  serviceName: string,
): unknown {
  const totals = sumUsage(turns);
  const time = isoNano(session.ended_at ?? session.started_at);
  const base = [attr('session.id', session.session_id), attr('gen_ai.system', session.agent)];

  const tokenPoint = (type: string, value: number) => ({
    asInt: value,
    timeUnixNano: time,
    attributes: [...base, attr('gen_ai.token.type', type)],
  });

  return {
    resourceMetrics: [
      {
        resource: resource(serviceName, session.host),
        scopeMetrics: [
          {
            scope: SCOPE,
            metrics: [
              {
                name: 'code_sessions.tokens',
                unit: '{token}',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    tokenPoint('input', totals.input),
                    tokenPoint('output', totals.output),
                    tokenPoint('cache_read', totals.cacheRead),
                    tokenPoint('cache_write', totals.cacheWrite),
                  ],
                },
              },
              {
                name: 'code_sessions.cost_usd',
                unit: 'USD',
                gauge: {
                  dataPoints: [
                    { asDouble: Math.round(totals.cost * 1e6) / 1e6, timeUnixNano: time, attributes: base },
                  ],
                },
              },
              {
                name: 'code_sessions.turns',
                unit: '{turn}',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [{ asInt: turns.length, timeUnixNano: time, attributes: base }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

export interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** POST an OTLP/HTTP JSON payload; resilient — never throws, returns a result. */
export async function postOtlp(
  endpoint: string,
  signalPath: '/v1/traces' | '/v1/metrics',
  payload: unknown,
  timeoutMs: number,
): Promise<PostResult> {
  const url = `${endpoint.replace(/\/$/, '')}${signalPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
