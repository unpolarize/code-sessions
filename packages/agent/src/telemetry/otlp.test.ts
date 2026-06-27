import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';
import { buildMetricPayload, buildTracePayload, isoNano, postOtlp, type Attribution } from './otlp';

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
  planning_refs: [],
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

const attribution: Attribution = {
  intent: 'feature',
  topic: 'otel exporter',
  repo: 'unpolarize/code-sessions',
  repoUrl: 'git@github.com:unpolarize/code-sessions.git',
  enduser: 'a@x.com',
  team: 'platform',
  department: 'eng',
  custom: { 'cost.center': 'cc-42', tenant: 'acme' },
};

describe('buildTracePayload attribution', () => {
  it('puts intent/topic/repo/identity on the root span as GenAI semconv attributes', () => {
    const p = buildTracePayload(envelope, turns, 'code-sessions', attribution) as any;
    const root = p.resourceSpans[0].scopeSpans[0].spans[0];
    const get = (k: string) => root.attributes.find((a: any) => a.key === k)?.value.stringValue;
    expect(get('gen_ai.conversation.intent')).toBe('feature');
    expect(get('gen_ai.conversation.topic')).toBe('otel exporter');
    expect(get('code.repository')).toBe('unpolarize/code-sessions');
    expect(get('vcs.repository.url')).toBe('git@github.com:unpolarize/code-sessions.git');
    expect(get('enduser.id')).toBe('a@x.com');
    expect(get('organization.team')).toBe('platform');
    expect(get('organization.department')).toBe('eng');
    // standard GenAI correlation/agent fields too
    expect(get('gen_ai.conversation.id')).toBe('sess-otlp');
    expect(get('gen_ai.agent.name')).toBe('claude-code');
    // user-defined custom attributes pass through verbatim
    expect(get('cost.center')).toBe('cc-42');
    expect(get('tenant')).toBe('acme');
  });

  it('omits attribution attributes entirely when none are given', () => {
    const p = buildTracePayload(envelope, turns, 'code-sessions') as any;
    const root = p.resourceSpans[0].scopeSpans[0].spans[0];
    expect(root.attributes.some((a: any) => a.key === 'enduser.id')).toBe(false);
    expect(root.attributes.some((a: any) => a.key === 'code.repository')).toBe(false);
  });

  it('tags each turn span with its classified category when provided', () => {
    const categories = new Map([[1, 'coding']]);
    const p = buildTracePayload(envelope, turns, 'code-sessions', undefined, categories) as any;
    const spans = p.resourceSpans[0].scopeSpans[0].spans;
    const turnSpan = (idx: number) =>
      spans.find((s: any) => s.attributes.some((a: any) => a.key === 'turn.index' && a.value.intValue === idx));
    const cat = turnSpan(1).attributes.find((a: any) => a.key === 'code_sessions.turn.category');
    expect(cat.value.stringValue).toBe('coding');
    expect(turnSpan(0).attributes.some((a: any) => a.key === 'code_sessions.turn.category')).toBe(false);
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

  it('carries attribution dims on every metric data point (group-by axes)', () => {
    const p = buildMetricPayload(envelope, turns, 'code-sessions', attribution) as any;
    const metrics = p.resourceMetrics[0].scopeMetrics[0].metrics;
    const dp = metrics.find((m: any) => m.name === 'code_sessions.tokens').sum.dataPoints[0];
    const get = (k: string) => dp.attributes.find((a: any) => a.key === k)?.value.stringValue;
    expect(get('code.repository')).toBe('unpolarize/code-sessions');
    expect(get('organization.team')).toBe('platform');
    expect(get('gen_ai.conversation.intent')).toBe('feature');
    expect(get('cost.center')).toBe('cc-42'); // custom dims are group-by axes too
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
