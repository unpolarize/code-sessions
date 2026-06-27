import { describe, expect, it } from 'vitest';
import type { Turn } from '@unpolarize/code-sessions-schema';
import { buildClassifyPrompt, classifyTurns, parseTurnCategories } from './classifier';

const cats = ['coding', 'debugging', 'planning', 'research'];

function turn(i: number, over: Partial<Turn> = {}): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 's',
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: 't',
    role: 'user',
    text: '',
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

describe('parseTurnCategories', () => {
  it('keeps valid pairs and normalizes the category to the configured casing', () => {
    const turns = [turn(0), turn(1)];
    const out = JSON.stringify([
      { turn_index: 0, category: 'Coding' },
      { turn_index: 1, category: 'debugging' },
    ]);
    expect(parseTurnCategories(out, turns, cats)).toEqual([
      { turn_index: 0, category: 'coding' },
      { turn_index: 1, category: 'debugging' },
    ]);
  });

  it('drops entries with an unknown category, out-of-range index, or duplicate index', () => {
    const turns = [turn(0), turn(1)];
    const out = JSON.stringify([
      { turn_index: 0, category: 'coding' },
      { turn_index: 1, category: 'nonsense' },
      { turn_index: 9, category: 'coding' },
      { turn_index: 0, category: 'planning' },
    ]);
    expect(parseTurnCategories(out, turns, cats)).toEqual([{ turn_index: 0, category: 'coding' }]);
  });

  it('tolerates code fences / surrounding prose and returns [] on garbage', () => {
    const turns = [turn(0)];
    expect(
      parseTurnCategories('```json\n[{"turn_index":0,"category":"coding"}]\n```', turns, cats),
    ).toEqual([{ turn_index: 0, category: 'coding' }]);
    expect(parseTurnCategories('not json at all', turns, cats)).toEqual([]);
  });
});

describe('buildClassifyPrompt', () => {
  it('lists the allowed categories and the per-turn indices', () => {
    const p = buildClassifyPrompt([turn(0, { text: 'fix the bug' })], cats);
    expect(p).toContain('coding, debugging, planning, research');
    expect(p).toContain('[0 user]');
  });
});

describe('classifyTurns', () => {
  it('returns [] without invoking the runner when categories or turns are empty', async () => {
    let called = 0;
    const runner = async () => {
      called++;
      return '[]';
    };
    expect(await classifyTurns([turn(0)], [], runner)).toEqual([]);
    expect(await classifyTurns([], cats, runner)).toEqual([]);
    expect(called).toBe(0);
  });

  it('classifies through the runner and validates against the allowed categories', async () => {
    const turns = [turn(0), turn(1)];
    const runner = async (prompt: string) => {
      expect(prompt).toContain('coding');
      return JSON.stringify([
        { turn_index: 0, category: 'coding' },
        { turn_index: 1, category: 'planning' },
      ]);
    };
    expect(await classifyTurns(turns, cats, runner)).toEqual([
      { turn_index: 0, category: 'coding' },
      { turn_index: 1, category: 'planning' },
    ]);
  });

  it('degrades to [] when the runner throws', async () => {
    const runner = async () => {
      throw new Error('ollama down');
    };
    expect(await classifyTurns([turn(0)], cats, runner)).toEqual([]);
  });
});
