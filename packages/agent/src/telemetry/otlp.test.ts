import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';
import { buildMetricPayload, buildTracePayload, isoNano, postOtlp } from './otlp';

const envelope: SessionEnvelope = {
  schema: 'session-store/session@1',
  session_id: 'sess-otlp',
  host: 'h',
  agent: 'claude-code',
  project_path: '/p',
  model: 'claude-opus-4-8',
  started_at: '2026-06-20T08:00:00Z',
  ended_at: '2026-06-20T08:05:00Z',
  turn_count: 2,
  tool_call_count: 1,
  totals: { input_tokens: 1100, output_tokens: 30, cost_usd: 0.5 },
  title: 'demo',
  labels: [],
  native_ref: { format: 'claude-jsonl', uuid: 'sess-otlp' },
};

const turns: Turn[] = [
  {
    schema: 'session-store/turn@1',
    session_id: 'sess-otlp',
    host: 'h',
    agent: 'claude-code',
    turn_index: 0,
    ts: '2026-06-20T08:00:00Z',
    role: 'user',
    text: 'hi',
    tool_calls: [],
    usage: { input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
  },
  {
    schema: 'session-store/turn@1',
    session_id: 'sess-otlp',
    host: 'h',
    agent: 'claude-code',
    turn_index: 1,
    ts: '2026-06-20T08:00:05Z',
    role: 'assistant',
    text: 'ok',
    tool_calls: [{ name: 'Edit' }],
    usage: { input_tokens: 1000, output_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0 },
    telemetry: { cost_usd: 0.5 },
    scrubbed: false,
    raw_ref: null,
  },
];

describe('isoNano', () => {
  it('converts ISO timestamps to unix nanoseconds', () => {
    expect(isoNano('2026-06-20T08:00:00Z')).toBe(`${Date.parse('2026-06-20T08:00:00Z')}000000`);
    expect(isoNano(undefined)).toBe('0');
    expect(isoNano('not-a-date')).toBe('0');
  });
});

describe('buildTracePayload', () => {
  it('emits a root span + one span per turn with valid ids', () => {
    const p = buildTracePayload(envelope, turns, 'code-sessions') as any;
    const spans = p.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(3); // root + 2 turns
    const [root, ...turnSpans] = spans;
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(turnSpans.every((s: any) => s.parentSpanId === root.spanId)).toBe(true);
    // resource carries service + host
    const attrs = p.resourceSpans[0].resource.attributes;
    expect(attrs.find((a: any) => a.key === 'service.name').value.stringValue).toBe('code-sessions');
    expect(attrs.find((a: any) => a.key === 'host.name').value.stringValue).toBe('h');
    // root carries token totals
    const inTok = root.attributes.find((a: any) => a.key === 'gen_ai.usage.input_tokens');
    expect(inTok.value.intValue).toBe(1100);
  });
});

describe('buildMetricPayload', () => {
  it('emits token sum + cost gauge + turn count', () => {
    const p = buildMetricPayload(envelope, turns, 'code-sessions') as any;
    const metrics = p.resourceMetrics[0].scopeMetrics[0].metrics;
    const byName = Object.fromEntries(metrics.map((m: any) => [m.name, m]));
    expect(byName['code_sessions.tokens'].sum.dataPoints).toHaveLength(4);
    expect(byName['code_sessions.cost_usd'].gauge.dataPoints[0].asDouble).toBe(0.5);
    expect(byName['code_sessions.turns'].sum.dataPoints[0].asInt).toBe(2);
  });
});

describe('postOtlp', () => {
  it('posts JSON to the collector and reports success', async () => {
    const received: { path: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await postOtlp(`http://127.0.0.1:${port}`, '/v1/traces', { hello: 1 }, 2000);
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(received[0]!.path).toBe('/v1/traces');
      expect(JSON.parse(received[0]!.body)).toEqual({ hello: 1 });
    } finally {
      await new Promise<void>((r) => (server as Server).close(() => r()));
    }
  });

  it('is resilient when the collector is unreachable (no throw)', async () => {
    const res = await postOtlp('http://127.0.0.1:9', '/v1/metrics', {}, 500);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
