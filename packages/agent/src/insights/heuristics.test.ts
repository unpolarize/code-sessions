import { describe, expect, it } from 'vitest';
import type { Turn } from '@unpolarize/code-sessions-schema';
import { deriveSignals, deriveTags, guessTopic } from './heuristics';

function turn(i: number, over: Partial<Turn> = {}): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 's',
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: 't',
    role: 'assistant',
    text: '',
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

describe('deriveSignals', () => {
  it('flags a stuck loop on repeated identical actions', () => {
    const turns = [
      turn(0, { tool_calls: [{ name: 'Bash', input: { command: 'ls' } }] }),
      turn(1, { tool_calls: [{ name: 'Bash', input: { command: 'ls' } }] }),
      turn(2, { tool_calls: [{ name: 'Bash', input: { command: 'ls' } }] }),
    ];
    const s = deriveSignals(turns);
    expect(s.some((x) => x.kind === 'stuck-loop' && x.severity === 'warn')).toBe(true);
  });

  it('flags error-recovery when a turn mentions an error', () => {
    const turns = [turn(0, { role: 'tool', text: 'TypeError: cannot read foo' })];
    expect(deriveSignals(turns).some((x) => x.kind === 'error-recovery')).toBe(true);
  });

  it('flags high-cost turns', () => {
    const turns = [turn(0, { telemetry: { cost_usd: 0.9 } })];
    expect(deriveSignals(turns).some((x) => x.kind === 'high-cost-turn')).toBe(true);
  });

  it('flags tool-heavy sessions', () => {
    const turns = [
      turn(0, { tool_calls: [{ name: 'Read' }, { name: 'Edit' }] }),
      turn(1, { tool_calls: [{ name: 'Bash' }] }),
    ];
    expect(deriveSignals(turns).some((x) => x.kind === 'tool-heavy')).toBe(true);
  });

  it('produces nothing notable for a calm short session', () => {
    const turns = [turn(0, { role: 'user', text: 'hi' }), turn(1, { text: 'hello' })];
    expect(deriveSignals(turns)).toEqual([]);
  });
});

describe('guessTopic / deriveTags', () => {
  it('guesses a topic from the first user turn', () => {
    const topic = guessTopic([turn(0, { role: 'user', text: 'Fix the bug in foo.ts please now' })]);
    expect(topic).toContain('Fix the bug');
  });

  it('collects distinct tool names as tags', () => {
    const tags = deriveTags([
      turn(0, { tool_calls: [{ name: 'Read' }, { name: 'Edit' }] }),
      turn(1, { tool_calls: [{ name: 'Read' }] }),
    ]);
    expect(tags.sort()).toEqual(['Edit', 'Read']);
  });
});
