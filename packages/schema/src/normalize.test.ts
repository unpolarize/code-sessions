import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildTurn,
  extractClaudeSessionMeta,
  normalizeClaudeEvent,
  normalizeClaudeLines,
} from './normalize';
import { parseTurn } from './validators';

const fixturePath = fileURLToPath(
  new URL('../test/fixtures/claude-session.jsonl', import.meta.url),
);

function loadFixtureLines(): unknown[] {
  return readFileSync(fixturePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe('normalizeClaudeEvent', () => {
  it('maps an assistant line to an assistant turn with tool calls and usage', () => {
    const lines = loadFixtureLines();
    const assistant = lines[2];
    const ev = normalizeClaudeEvent(assistant);
    expect(ev).not.toBeNull();
    expect(ev!.role).toBe('assistant');
    expect(ev!.text).toContain("I'll read the file.");
    expect(ev!.tool_calls).toHaveLength(1);
    expect(ev!.tool_calls[0]).toMatchObject({ name: 'Read', id: 'tu_1' });
    expect(ev!.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 45,
      cache_read_tokens: 8000,
      cache_write_tokens: 100,
    });
  });

  it('maps a tool_result user line to a tool turn', () => {
    const lines = loadFixtureLines();
    const ev = normalizeClaudeEvent(lines[3]);
    expect(ev!.role).toBe('tool');
    expect(ev!.text).toContain('export const foo = 1;');
  });

  it('maps a plain user line to a user turn', () => {
    const lines = loadFixtureLines();
    const ev = normalizeClaudeEvent(lines[0]);
    expect(ev!.role).toBe('user');
    expect(ev!.text).toBe('Fix the bug in foo.ts');
  });

  it('returns null for metadata lines (system, ai-title)', () => {
    const lines = loadFixtureLines();
    expect(normalizeClaudeEvent(lines[1])).toBeNull(); // system
    expect(normalizeClaudeEvent(lines[4])).toBeNull(); // ai-title
    expect(normalizeClaudeEvent(null)).toBeNull();
    expect(normalizeClaudeEvent({ type: 'permission-mode' })).toBeNull();
  });
});

describe('normalizeClaudeLines', () => {
  it('produces conversational turns with sequential indices', () => {
    const lines = loadFixtureLines();
    const { turns } = normalizeClaudeLines(lines, {
      session_id: 'sess-abc',
      host: 'test-host',
      agent: 'claude-code',
    });
    // 1 user + 1 assistant + 1 tool + 1 assistant = 4 (system + ai-title dropped)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(turns.map((t) => t.turn_index)).toEqual([0, 1, 2, 3]);
    for (const t of turns) {
      expect(() => parseTurn(t)).not.toThrow();
      expect(t.session_id).toBe('sess-abc');
      expect(t.host).toBe('test-host');
      expect(t.agent).toBe('claude-code');
    }
  });

  it('respects a startIndex for incremental capture', () => {
    const lines = loadFixtureLines();
    const { turns } = normalizeClaudeLines(lines.slice(5), {
      session_id: 'sess-abc',
      host: 'test-host',
      agent: 'claude-code',
      startIndex: 7,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turn_index).toBe(7);
    expect(turns[0]!.text).toBe('Fixed it.');
  });
});

describe('extractClaudeSessionMeta', () => {
  it('pulls envelope metadata from a batch of lines', () => {
    const meta = extractClaudeSessionMeta(loadFixtureLines());
    expect(meta.session_id).toBe('sess-abc');
    expect(meta.project_path).toBe('/Users/z/proj');
    expect(meta.git_branch).toBe('main');
    expect(meta.model).toBe('claude-opus-4-8');
    expect(meta.title).toBe('Fix bug in foo.ts');
    expect(meta.started_at).toBe('2026-06-20T08:00:00Z');
    expect(meta.ended_at).toBe('2026-06-20T08:00:10Z');
  });
});

describe('buildTurn', () => {
  it('assembles a schema-valid turn from a normalized event', () => {
    const ev = normalizeClaudeEvent(loadFixtureLines()[0])!;
    const turn = buildTurn(ev, {
      session_id: 's',
      host: 'h',
      agent: 'claude-code',
      turn_index: 0,
    });
    expect(turn.schema).toBe('session-store/turn@1');
    expect(() => parseTurn(turn)).not.toThrow();
  });
});
