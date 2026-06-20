import { describe, expect, it } from 'vitest';
import type { Turn } from '@unpolarize/code-sessions-schema';
import { LlmProvider, buildPrompt, parseLabelJson } from './llm';

function turn(i: number, role: Turn['role'], text: string): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 's',
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: 't',
    role,
    text,
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
  };
}

describe('buildPrompt', () => {
  it('includes the transcript and a JSON instruction', () => {
    const p = buildPrompt({
      sessionId: 's',
      host: 'h',
      turns: [turn(0, 'user', 'fix foo'), turn(1, 'assistant', 'done')],
    });
    expect(p).toContain('ONLY a JSON object');
    expect(p).toContain('[user] fix foo');
    expect(p).toContain('[assistant] done');
  });
});

describe('parseLabelJson', () => {
  it('parses a clean JSON object', () => {
    const r = parseLabelJson('{"topic":"debugging","tags":["foo"],"summary":"s","signals":[]}');
    expect(r.topic).toBe('debugging');
    expect(r.tags).toEqual(['foo']);
    expect(r.summary).toBe('s');
  });

  it('tolerates surrounding prose', () => {
    const r = parseLabelJson('Sure! Here:\n{"topic":"x","tags":[]}\nHope that helps.');
    expect(r.topic).toBe('x');
  });

  it('drops invalid signal kinds and coerces severity', () => {
    const r = parseLabelJson(
      '{"tags":[],"signals":[{"kind":"bogus"},{"kind":"stuck-loop","severity":"nope","note":"n"}]}',
    );
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]).toMatchObject({ kind: 'stuck-loop', severity: 'info', note: 'n' });
  });

  it('returns empty on non-JSON', () => {
    expect(parseLabelJson('no json here')).toEqual({ tags: [], signals: [] });
  });
});

describe('LlmProvider', () => {
  it('labels via an injected runner', async () => {
    const provider = new LlmProvider('stub', async () => '{"topic":"t","tags":["a"],"signals":[]}');
    const res = await provider.label({ sessionId: 's', host: 'h', turns: [turn(0, 'user', 'hi')] });
    expect(res.topic).toBe('t');
    expect(res.tags).toEqual(['a']);
  });

  it('propagates runner errors (labeler handles the fallback)', async () => {
    const provider = new LlmProvider('stub', async () => {
      throw new Error('no cli');
    });
    await expect(
      provider.label({ sessionId: 's', host: 'h', turns: [turn(0, 'user', 'hi')] }),
    ).rejects.toThrow('no cli');
  });
});
