import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSIONS } from './schemas';
import {
  insightsJsonSchema,
  parseInsights,
  parseSession,
  parseTurn,
  safeParseTurn,
  sessionJsonSchema,
  turnJsonSchema,
} from './validators';

describe('TurnSchema', () => {
  it('applies defaults for optional fields', () => {
    const turn = parseTurn({
      schema: SCHEMA_VERSIONS.turn,
      session_id: 's',
      host: 'h',
      agent: 'claude-code',
      turn_index: 0,
      ts: '2026-06-20T00:00:00Z',
      role: 'assistant',
    });
    expect(turn.text).toBe('');
    expect(turn.tool_calls).toEqual([]);
    expect(turn.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    expect(turn.scrubbed).toBe(false);
    expect(turn.raw_ref).toBeNull();
  });

  it('rejects unknown top-level keys (strict)', () => {
    const res = safeParseTurn({
      schema: SCHEMA_VERSIONS.turn,
      session_id: 's',
      host: 'h',
      agent: 'claude-code',
      turn_index: 0,
      ts: 't',
      role: 'user',
      bogus: true,
    });
    expect(res.success).toBe(false);
  });

  it('rejects an invalid agent', () => {
    expect(
      safeParseTurn({
        schema: SCHEMA_VERSIONS.turn,
        session_id: 's',
        host: 'h',
        agent: 'not-an-agent',
        turn_index: 0,
        ts: 't',
        role: 'user',
      }).success,
    ).toBe(false);
  });

  it('round-trips through JSON', () => {
    const turn = parseTurn({
      schema: SCHEMA_VERSIONS.turn,
      session_id: 's',
      host: 'h',
      agent: 'claude-code',
      turn_index: 3,
      ts: 't',
      role: 'assistant',
      text: 'hi',
      tool_calls: [{ name: 'Edit', input: { file_path: 'x' }, id: 'a' }],
    });
    const restored = parseTurn(JSON.parse(JSON.stringify(turn)));
    expect(restored).toEqual(turn);
  });
});

describe('SessionSchema', () => {
  it('parses a minimal envelope with defaults', () => {
    const s = parseSession({
      schema: SCHEMA_VERSIONS.session,
      session_id: 's',
      host: 'h',
      agent: 'claude-code',
      native_ref: { format: 'claude-jsonl', uuid: 's' },
    });
    expect(s.turn_count).toBe(0);
    expect(s.labels).toEqual([]);
    expect(s.totals.cost_usd).toBe(0);
  });
});

describe('InsightsSchema', () => {
  it('parses insights with signals', () => {
    const i = parseInsights({
      schema: SCHEMA_VERSIONS.insights,
      session_id: 's',
      host: 'h',
      generated_at: 't',
      provider: 'fake',
      topic: 'debugging',
      tags: ['bug', 'foo.ts'],
      signals: [{ kind: 'error-recovery', severity: 'warn', turn_index: 2 }],
    });
    expect(i.signals[0]!.kind).toBe('error-recovery');
    expect(i.tags).toContain('bug');
  });
});

describe('JSON Schema exports', () => {
  it('exports object schemas for external consumers', () => {
    for (const s of [turnJsonSchema, sessionJsonSchema, insightsJsonSchema]) {
      expect(typeof s).toBe('object');
      expect(s).not.toBeNull();
    }
  });
});
