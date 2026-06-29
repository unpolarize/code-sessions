import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';
import { buildTurnTraces } from './genai';
import type { Attribution } from './otlp';

/**
 * Replay the REAL, redacted fixtures (test/fixtures/real/<agent>/*.json — built by
 * test/harness/make-fixtures.mts from actual Claude/Codex/Grok sessions) through the
 * GenAI-semconv adapter, asserting the model holds on real data: valid span tree +
 * the leaf-only-usage property that prevents double-counting.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../test/fixtures/real');

interface Fixture {
  agent: string;
  sessionId: string;
  meta: { model?: string; project_path?: string };
  turns: Turn[];
}

function loadFixtures(): Fixture[] {
  if (!existsSync(FIXTURES)) return [];
  const out: Fixture[] = [];
  for (const agent of readdirSync(FIXTURES)) {
    const dir = join(FIXTURES, agent);
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      continue; // manifest.json (a file, not a dir)
    }
    for (const n of names) out.push(JSON.parse(readFileSync(join(dir, n), 'utf8')) as Fixture);
  }
  return out;
}

function envelopeOf(f: Fixture): SessionEnvelope {
  const totals = f.turns.reduce(
    (a, t) => ({ input: a.input + t.usage.input_tokens, output: a.output + t.usage.output_tokens }),
    { input: 0, output: 0 },
  );
  return {
    schema: 'session-store/session@1',
    session_id: f.sessionId,
    host: 'box-a',
    agent: f.turns[0]?.agent ?? 'claude-code',
    project_path: f.meta.project_path ?? '',
    ...(f.meta.model ? { model: f.meta.model } : {}),
    turn_count: f.turns.length,
    tool_call_count: f.turns.reduce((a, t) => a + t.tool_calls.length, 0),
    totals: { input_tokens: totals.input, output_tokens: totals.output, cost_usd: 0 },
    labels: [],
    planning_refs: [],
    native_ref: { format: 'claude-jsonl', uuid: f.sessionId },
  };
}

const ATTR: Attribution = { enduser: 'dev@a.com', repo: 'acme/app', custom: { 'cost.center': 'cc-1' } };
const allSpans = (p: any) => p.resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans));
const sv = (s: any, k: string) => s.attributes.find((a: any) => a.key === k)?.value.stringValue;
const iv = (s: any, k: string) => s.attributes.find((a: any) => a.key === k)?.value.intValue;

const fixtures = loadFixtures();

describe('GenAI adapter — real-data replay', () => {
  it('found fixtures to replay', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const f of fixtures) {
    describe(`${f.agent}/${f.sessionId.slice(0, 8)} (${f.turns.length} turns)`, () => {
      const payload = () => buildTurnTraces(envelopeOf(f), f.turns, 'code-sessions', ATTR) as any;

      it('emits a valid span tree (invoke_agent roots + chat/execute_tool children)', () => {
        const spans = allSpans(payload());
        const roots = spans.filter((s: any) => sv(s, 'gen_ai.operation.name') === 'invoke_agent');
        expect(roots.length).toBeGreaterThan(0);
        // every span belongs to a trace that has a root; chat/tool spans have parents
        for (const s of spans) {
          const op = sv(s, 'gen_ai.operation.name');
          if (op === 'invoke_agent') expect(s.parentSpanId == null || s.parentSpanId === '').toBe(true);
          else expect(typeof s.parentSpanId).toBe('string');
        }
        // conversation correlation
        for (const r of roots) expect(sv(r, 'gen_ai.conversation.id')).toBe(f.sessionId);
      });

      it('puts usage only on chat spans → Σ chat tokens == Σ assistant-turn tokens (no double-count)', () => {
        const chats = allSpans(payload()).filter((s: any) => sv(s, 'gen_ai.operation.name') === 'chat');
        const fromSpans = chats.reduce((a: number, c: any) => a + (iv(c, 'gen_ai.usage.input_tokens') ?? 0), 0);
        const fromTurns = f.turns.filter((t) => t.role === 'assistant').reduce((a, t) => a + t.usage.input_tokens, 0);
        expect(fromSpans).toBe(fromTurns);
      });

      it('carries enrichment on every turn root', () => {
        const roots = allSpans(payload()).filter((s: any) => sv(s, 'gen_ai.operation.name') === 'invoke_agent');
        for (const r of roots) {
          expect(sv(r, 'enduser.id')).toBe('dev@a.com');
          expect(sv(r, 'code.repository')).toBe('acme/app');
        }
      });
    });
  }
});
