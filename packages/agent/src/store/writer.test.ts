import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSession, type Turn } from '@unpolarize/code-sessions-schema';
import { withTempDir } from '../test/tmp';
import { envelopeFile, sessionDir } from './paths';
import { computeEnvelope, readTurns, rebuildEnvelope, writeTurnFile } from './writer';

function mkTurn(i: number, over: Partial<Turn> = {}): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 'sess-1',
    host: 'test-host',
    agent: 'claude-code',
    turn_index: i,
    ts: `2026-06-20T08:0${i}:00Z`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `turn ${i}`,
    tool_calls: [],
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

describe('writeTurnFile', () => {
  it('writes immutably and never overwrites', () => {
    withTempDir((store) => {
      const dir = sessionDir(store, 'test-host', '2026-06', 'sess-1');
      const first = writeTurnFile(dir, mkTurn(0, { text: 'original' }));
      expect(first.written).toBe(true);
      const second = writeTurnFile(dir, mkTurn(0, { text: 'CLOBBER' }));
      expect(second.written).toBe(false);
      const onDisk = JSON.parse(readFileSync(first.path, 'utf8')) as Turn;
      expect(onDisk.text).toBe('original');
    });
  });
});

describe('computeEnvelope', () => {
  it('aggregates totals, counts, and timestamps from turns', () => {
    const turns = [
      mkTurn(0),
      mkTurn(1, {
        tool_calls: [{ name: 'Edit' }],
        telemetry: { cost_usd: 0.5 },
      }),
    ];
    const env = computeEnvelope(
      turns,
      { model: 'claude-opus-4-8', project_path: '/p', git_branch: 'main', title: 'T' },
      { session_id: 'sess-1', host: 'test-host', agent: 'claude-code', native_uuid: 'sess-1' },
    );
    expect(env.turn_count).toBe(2);
    expect(env.tool_call_count).toBe(1);
    expect(env.totals.input_tokens).toBe(200);
    expect(env.totals.cost_usd).toBe(0.5);
    expect(env.started_at).toBe('2026-06-20T08:00:00Z');
    expect(env.ended_at).toBe('2026-06-20T08:01:00Z');
    expect(env.model).toBe('claude-opus-4-8');
    expect(env.title).toBe('T');
    expect(() => parseSession(env)).not.toThrow();
  });

  it('preserves prior labels from an existing envelope', () => {
    const env = computeEnvelope([mkTurn(0)], {}, {
      session_id: 'sess-1',
      host: 'h',
      agent: 'claude-code',
      native_uuid: 'sess-1',
    }, { labels: ['debugging'] });
    expect(env.labels).toEqual(['debugging']);
  });
});

describe('rebuildEnvelope', () => {
  it('reads turns from disk and writes session.json', () => {
    withTempDir((store) => {
      const dir = sessionDir(store, 'test-host', '2026-06', 'sess-1');
      writeTurnFile(dir, mkTurn(0));
      writeTurnFile(dir, mkTurn(1));
      const env = rebuildEnvelope(store, 'test-host', '2026-06', 'sess-1', { model: 'claude-opus-4-8' }, {
        session_id: 'sess-1',
        host: 'test-host',
        agent: 'claude-code',
        native_uuid: 'sess-1',
      });
      expect(env.turn_count).toBe(2);
      expect(existsSync(envelopeFile(dir))).toBe(true);
      expect(readTurns(dir)).toHaveLength(2);
    });
  });
});
