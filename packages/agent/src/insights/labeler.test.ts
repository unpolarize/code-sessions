import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Turn } from '@unpolarize/code-sessions-schema';
import { makeConfig, withTempDirAsync } from '../test/tmp';
import { envelopeFile, insightsFile, sessionDir } from '../store/paths';
import { rebuildEnvelope, writeTurnFile } from '../store/writer';
import { FakeProvider, type Provider } from './provider';
import { labelSession, makeProvider, reindexStore } from './labeler';

function turn(i: number, over: Partial<Turn> = {}): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 's1',
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: `2026-06-20T08:0${i}:00Z`,
    role: 'assistant',
    text: '',
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

function seedSession(store: string): string {
  const dir = sessionDir(store, 'h', '2026-06', 's1');
  writeTurnFile(dir, turn(0, { role: 'user', text: 'Fix the bug in foo.ts' }));
  writeTurnFile(dir, turn(1, { tool_calls: [{ name: 'Edit' }], telemetry: { cost_usd: 0.9 }, text: 'editing' }));
  rebuildEnvelope(store, 'h', '2026-06', 's1', { model: 'claude-opus-4-8' }, {
    session_id: 's1',
    host: 'h',
    agent: 'claude-code',
    native_uuid: 's1',
  });
  return dir;
}

describe('labelSession', () => {
  it('writes insights and reflects labels onto the envelope', async () => {
    await withTempDirAsync(async (store) => {
      const dir = seedSession(store);
      const ins = await labelSession(dir, { sessionId: 's1', host: 'h' }, new FakeProvider(), {
        now: '2026-06-20T09:00:00Z',
      });
      expect(ins).toBeDefined();
      expect(ins!.topic).toContain('Fix the bug');
      expect(ins!.tags).toContain('Edit');
      expect(ins!.signals.some((s) => s.kind === 'high-cost-turn')).toBe(true);
      expect(ins!.generated_at).toBe('2026-06-20T09:00:00Z');
      expect(existsSync(insightsFile(dir))).toBe(true);

      const env = JSON.parse(readFileSync(envelopeFile(dir), 'utf8'));
      expect(env.labels).toContain('Edit');
    });
  });

  it('degrades to heuristics when the provider throws', async () => {
    await withTempDirAsync(async (store) => {
      const dir = seedSession(store);
      const failing: Provider = {
        name: 'broken',
        label: async () => {
          throw new Error('no cli');
        },
      };
      const ins = await labelSession(dir, { sessionId: 's1', host: 'h' }, failing);
      expect(ins).toBeDefined();
      // heuristics still produced a high-cost signal and a topic guess
      expect(ins!.signals.some((s) => s.kind === 'high-cost-turn')).toBe(true);
      expect(ins!.topic).toContain('Fix the bug');
    });
  });

  it('returns undefined for an empty session', async () => {
    await withTempDirAsync(async (store) => {
      const dir = sessionDir(store, 'h', '2026-06', 'empty');
      const ins = await labelSession(dir, { sessionId: 'empty', host: 'h' }, new FakeProvider());
      expect(ins).toBeUndefined();
    });
  });
});

describe('reindexStore', () => {
  it('labels every session in the store', async () => {
    await withTempDirAsync(async (store) => {
      seedSession(store);
      const res = await reindexStore(makeConfig(store), new FakeProvider(), {
        now: '2026-06-20T09:00:00Z',
      });
      expect(res.count).toBe(1);
      expect(res.sessions).toContain('s1');
    });
  });
});

describe('makeProvider', () => {
  it('returns null when disabled and a FakeProvider when configured', () => {
    expect(makeProvider(makeConfig('/tmp/x', { insights: { provider: 'none' } }))).toBeNull();
    expect(makeProvider(makeConfig('/tmp/x', { insights: { provider: 'fake' } }))?.name).toBe('fake');
    expect(makeProvider(makeConfig('/tmp/x', { insights: { provider: 'ollama' } }))?.name).toBe('ollama');
  });
});
