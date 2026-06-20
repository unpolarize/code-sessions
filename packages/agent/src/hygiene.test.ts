import { describe, expect, it } from 'vitest';
import { parseTurn } from '@unpolarize/code-sessions-schema';
import { applyHygiene, scrubSecrets, sha256 } from './hygiene';

function turn(text: string): ReturnType<typeof parseTurn> {
  return parseTurn({
    schema: 'session-store/turn@1',
    session_id: 's',
    host: 'h',
    agent: 'claude-code',
    turn_index: 0,
    ts: 't',
    role: 'assistant',
    text,
    raw: { original: text },
  });
}

describe('scrubSecrets', () => {
  it('redacts common secret shapes', () => {
    const samples = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD',
      'sk-ant-api03-abcdefghij_klmnopqrstuvwxyz1234567890',
      'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
    ];
    for (const s of samples) {
      const { text, matches } = scrubSecrets(`token=${s} end`);
      expect(text).not.toContain(s);
      expect(text).toContain('[REDACTED:');
      expect(matches.reduce((a, m) => a + m.count, 0)).toBeGreaterThan(0);
    }
  });

  it('leaves clean text untouched', () => {
    const { text, matches } = scrubSecrets('just a normal sentence about foo.ts');
    expect(text).toBe('just a normal sentence about foo.ts');
    expect(matches).toHaveLength(0);
  });
});

describe('applyHygiene', () => {
  it('scrubs and drops raw when a secret is found', () => {
    const res = applyHygiene(turn('key ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD here'), {
      maxTurnBytes: 64 * 1024,
      scrubSecrets: true,
    });
    expect(res.turn.scrubbed).toBe(true);
    expect(res.turn.text).toContain('[REDACTED:github-token]');
    expect(res.turn.raw).toBeUndefined();
    expect(res.redactions.length).toBeGreaterThan(0);
  });

  it('externalizes oversized text to a content-addressed blob', () => {
    const big = 'x'.repeat(2000);
    const res = applyHygiene(turn(big), { maxTurnBytes: 512, scrubSecrets: true });
    expect(res.blob).toBeDefined();
    expect(res.blob!.sha).toBe(sha256(big));
    expect(res.turn.raw_ref).toBe(res.blob!.sha);
    expect(res.turn.text.length).toBeLessThan(big.length);
    expect(res.turn.text).toContain('externalized');
    expect(res.turn.raw).toBeUndefined();
  });

  it('is a no-op for small clean turns (keeps raw)', () => {
    const res = applyHygiene(turn('hello world'), { maxTurnBytes: 64 * 1024, scrubSecrets: true });
    expect(res.turn.scrubbed).toBe(false);
    expect(res.blob).toBeUndefined();
    expect(res.turn.raw).toEqual({ original: 'hello world' });
  });

  it('does not mutate the input turn', () => {
    const t = turn('ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD');
    applyHygiene(t, { maxTurnBytes: 64 * 1024, scrubSecrets: true });
    expect(t.text).toContain('ghp_');
    expect(t.scrubbed).toBe(false);
  });
});
