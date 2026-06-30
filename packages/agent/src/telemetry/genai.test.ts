import { describe, expect, it } from 'vitest';
import type { SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';
import type { Attribution } from './otlp';
import { buildTurnTraces, buildGenaiMetrics } from './genai';

function turn(i: number, role: Turn['role'], over: Partial<Turn> = {}): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 'sess-1',
    host: 'box-a',
    agent: 'claude-code',
    turn_index: i,
    ts: `2026-06-20T08:00:0${i}Z`,
    role,
    text: '',
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

function envelope(over: Partial<SessionEnvelope> = {}): SessionEnvelope {
  return {
    schema: 'session-store/session@1',
    session_id: 'sess-1',
    host: 'box-a',
    agent: 'claude-code',
    project_path: '/work/app',
    model: 'claude-opus-4-8',
    turn_count: 0,
    tool_call_count: 0,
    totals: { input_tokens: 1500, output_tokens: 70, cost_usd: 0.03 },
    labels: [],
    planning_refs: [],
    native_ref: { format: 'claude-jsonl', uuid: 'sess-1' },
    ...over,
  };
}

// A two-conversational-turn session: user → assistant(+Edit tool) → tool result → user → assistant
const TURNS: Turn[] = [
  turn(0, 'user', { text: 'fix the bug in a.ts' }),
  turn(1, 'assistant', {
    text: 'editing',
    tool_calls: [{ name: 'Edit', input: { file_path: 'a.ts' }, id: 'tc1' } as Turn['tool_calls'][number]],
    usage: { input_tokens: 1000, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 },
    telemetry: { cost_usd: 0.02 },
  }),
  turn(2, 'tool', { text: 'ok' }),
  turn(3, 'user', { text: 'now run the tests' }),
  turn(4, 'assistant', {
    text: 'done',
    usage: { input_tokens: 500, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0 },
    telemetry: { cost_usd: 0.01 },
  }),
];

const ATTR: Attribution = {
  enduser: 'dev@a.com',
  repo: 'acme/app',
  repoUrl: 'git@github.com:acme/app.git',
  intent: 'feature',
  custom: { 'cost.center': 'cc-1' },
};

const allSpans = (p: any) => p.resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans));
const sv = (span: any, k: string) => span.attributes.find((a: any) => a.key === k)?.value.stringValue;
const iv = (span: any, k: string) => span.attributes.find((a: any) => a.key === k)?.value.intValue;

describe('buildTurnTraces — turn = trace, invocation = span', () => {
  it('emits one trace per conversational turn (split on user message)', () => {
    const p = buildTurnTraces(envelope(), TURNS, 'code-sessions', ATTR) as any;
    const traceIds = new Set(allSpans(p).map((s: any) => s.traceId));
    expect(traceIds.size).toBe(2); // two turns → two traces
  });

  it('each turn-trace has an invoke_agent root with the session as conversation.id', () => {
    const p = buildTurnTraces(envelope(), TURNS, 'code-sessions', ATTR) as any;
    const roots = allSpans(p).filter((s: any) => sv(s, 'gen_ai.operation.name') === 'invoke_agent');
    expect(roots).toHaveLength(2);
    for (const r of roots) {
      expect(sv(r, 'gen_ai.conversation.id')).toBe('sess-1');
      expect(sv(r, 'gen_ai.provider.name')).toBe('anthropic');
      expect(r.parentSpanId == null || r.parentSpanId === '').toBe(true);
    }
  });

  it('emits chat (LLM) + execute_tool spans as children, with the right names', () => {
    const p = buildTurnTraces(envelope(), TURNS, 'code-sessions', ATTR) as any;
    const spans = allSpans(p);
    const chats = spans.filter((s: any) => sv(s, 'gen_ai.operation.name') === 'chat');
    const tools = spans.filter((s: any) => sv(s, 'gen_ai.operation.name') === 'execute_tool');
    expect(chats).toHaveLength(2); // two assistant responses
    expect(tools).toHaveLength(1); // one Edit
    expect(chats[0].name).toBe('chat claude-opus-4-8');
    expect(sv(tools[0], 'gen_ai.tool.name')).toBe('Edit');
    expect(sv(tools[0], 'gen_ai.tool.call.id')).toBe('tc1');
    // tool span is a child of a chat span, which is a child of the root
    const chatIds = new Set(chats.map((c: any) => c.spanId));
    expect(chatIds.has(tools[0].parentSpanId)).toBe(true);
  });

  it('puts tokens/cost ONLY on chat spans; Σ chat tokens == session total (no rollup double-count)', () => {
    const p = buildTurnTraces(envelope(), TURNS, 'code-sessions', ATTR) as any;
    const spans = allSpans(p);
    const roots = spans.filter((s: any) => sv(s, 'gen_ai.operation.name') === 'invoke_agent');
    // roots carry NO usage (no rollup)
    for (const r of roots) expect(iv(r, 'gen_ai.usage.input_tokens')).toBeUndefined();
    const chats = spans.filter((s: any) => sv(s, 'gen_ai.operation.name') === 'chat');
    const sumIn = chats.reduce((a: number, c: any) => a + (iv(c, 'gen_ai.usage.input_tokens') ?? 0), 0);
    expect(sumIn).toBe(1500); // == envelope.totals.input_tokens
  });

  it('carries enrichment on the root span', () => {
    const p = buildTurnTraces(envelope(), TURNS, 'code-sessions', ATTR) as any;
    const root = allSpans(p).find((s: any) => sv(s, 'gen_ai.operation.name') === 'invoke_agent');
    expect(sv(root, 'enduser.id')).toBe('dev@a.com');
    expect(sv(root, 'code.repository')).toBe('acme/app');
    expect(sv(root, 'cost.center')).toBe('cc-1');
    expect(sv(root, 'gen_ai.conversation.intent')).toBe('feature');
  });

  it('emits a consolidated `metadata` JSON bag on the root span (Galileo user_metadata)', () => {
    const p = buildTurnTraces(envelope(), TURNS, 'code-sessions', ATTR) as any;
    const roots = allSpans(p).filter((s: any) => sv(s, 'gen_ai.operation.name') === 'invoke_agent');
    for (const root of roots) {
      const bag = JSON.parse(sv(root, 'metadata'));
      expect(bag['enduser.id']).toBe('dev@a.com');
      expect(bag['code.repository']).toBe('acme/app');
      expect(bag['gen_ai.conversation.intent']).toBe('feature');
      expect(bag['gen_ai.system']).toBe('claude-code');
      // cost is per-turn; both turns have one assistant record with a cost
      expect(Number(bag['code_sessions.cost_usd'])).toBeGreaterThan(0);
    }
    // first turn's assistant cost 0.02, second 0.01 → bags differ
    const costs = roots.map((r: any) => Number(JSON.parse(sv(r, 'metadata'))['code_sessions.cost_usd']));
    expect(costs.sort()).toEqual([0.01, 0.02]);
  });

  it('uses deterministic, idempotent ids (re-export is stable)', () => {
    const a = buildTurnTraces(envelope(), TURNS, 'code-sessions', ATTR) as any;
    const b = buildTurnTraces(envelope(), TURNS, 'code-sessions', ATTR) as any;
    expect(allSpans(a).map((s: any) => s.spanId)).toEqual(allSpans(b).map((s: any) => s.spanId));
  });

  it('maps provider per agent', () => {
    const codex = buildTurnTraces(envelope({ agent: 'codex' }), [turn(0, 'user'), turn(1, 'assistant')], 'cs') as any;
    const root = allSpans(codex).find((s: any) => sv(s, 'gen_ai.operation.name') === 'invoke_agent');
    expect(sv(root, 'gen_ai.provider.name')).toBe('openai');
  });
});

describe('buildGenaiMetrics (optional)', () => {
  it('emits per-chat token data points that sum to the session total', () => {
    const p = buildGenaiMetrics(envelope(), TURNS, 'code-sessions', ATTR) as any;
    const sum = p.resourceMetrics[0].scopeMetrics[0].metrics.find((m: any) => m.name === 'gen_ai.client.token.usage');
    const inputs = sum.sum.dataPoints.filter(
      (d: any) => d.attributes.find((a: any) => a.key === 'gen_ai.token.type')?.value.stringValue === 'input',
    );
    expect(inputs.reduce((a: number, d: any) => a + d.asInt, 0)).toBe(1500);
  });
});
