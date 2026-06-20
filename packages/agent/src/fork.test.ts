import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Turn } from '@unpolarize/code-sessions-schema';
import { forkSession } from './fork';
import { envelopeFile, sessionDir, turnFile } from './store/paths';
import { rebuildEnvelope, readTurns, writeTurnFile } from './store/writer';
import { makeConfig, withTempDir } from './test/tmp';

function turn(i: number, role: Turn['role'], text: string): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 'src',
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: `2026-06-20T08:0${i}:00Z`,
    role,
    text,
    tool_calls: [],
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
  };
}

function seed(store: string): void {
  const dir = sessionDir(store, 'test-host', '2026-06', 'src');
  writeTurnFile(dir, turn(0, 'user', 'start the feature'));
  writeTurnFile(dir, turn(1, 'assistant', 'working on it'));
  writeTurnFile(dir, turn(2, 'user', 'change of plan'));
  writeTurnFile(dir, turn(3, 'assistant', 'ok redoing'));
  rebuildEnvelope(store, 'test-host', '2026-06', 'src', { model: 'claude-opus-4-8', title: 'feature work' }, {
    session_id: 'src',
    host: 'test-host',
    agent: 'claude-code',
    native_uuid: 'src',
  });
}

describe('forkSession', () => {
  it('branches a session at a turn with lineage', () => {
    withTempDir((store) => {
      seed(store);
      const cfg = makeConfig(store);
      const res = forkSession(cfg, { sessionId: 'src', atTurn: 1, newSessionId: 'fork1' });
      expect(res.newSessionId).toBe('fork1');
      expect(res.turns).toBe(2); // turns 0 and 1 only
      expect(res.forkedFrom).toEqual({ session_id: 'src', turn_index: 1 });

      const dir = sessionDir(store, 'test-host', '2026-06', 'fork1');
      expect(existsSync(turnFile(dir, 0))).toBe(true);
      expect(existsSync(turnFile(dir, 1))).toBe(true);
      expect(existsSync(turnFile(dir, 2))).toBe(false); // not copied

      const forkTurns = readTurns(dir);
      expect(forkTurns.every((t) => t.session_id === 'fork1')).toBe(true);

      const env = JSON.parse(readFileSync(envelopeFile(dir), 'utf8'));
      expect(env.forked_from).toEqual({ session_id: 'src', turn_index: 1 });
      expect(env.title).toBe('fork: feature work');
      expect(env.native_ref.format).toBe('fork');
    });
  });

  it('can fork into a different agent', () => {
    withTempDir((store) => {
      seed(store);
      const res = forkSession(makeConfig(store), { sessionId: 'src', atTurn: 0, agent: 'grok' });
      const env = JSON.parse(readFileSync(envelopeFile(res.sessionDir), 'utf8'));
      expect(env.agent).toBe('grok');
      expect(res.turns).toBe(1);
    });
  });

  it('throws for a missing session', () => {
    withTempDir((store) => {
      expect(() => forkSession(makeConfig(store), { sessionId: 'nope', atTurn: 0 })).toThrow(/not found/);
    });
  });
});
