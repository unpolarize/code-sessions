import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Turn } from '@unpolarize/code-sessions-schema';
import { FakeProvider } from '../insights/provider';
import { labelSession } from '../insights/labeler';
import { sessionDir } from '../store/paths';
import { rebuildEnvelope, writeTurnFile } from '../store/writer';
import { makeConfig, withTempDirAsync } from '../test/tmp';
import { SessionIndex } from './db';
import { syncIndex } from './sync';

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
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

async function seed(store: string, id: string): Promise<string> {
  const dir = sessionDir(store, 'h', '2026-06', id);
  writeTurnFile(dir, turn(0, { session_id: id, role: 'user', text: 'fix the parser bug' }));
  writeTurnFile(dir, turn(1, { session_id: id, tool_calls: [{ name: 'Edit' }] }));
  rebuildEnvelope(store, 'h', '2026-06', id, { model: 'claude-opus-4-8' }, {
    session_id: id,
    host: 'h',
    agent: 'claude-code',
    native_uuid: id,
  });
  await labelSession(dir, { sessionId: id, host: 'h' }, new FakeProvider(), { now: '2026-06-20T09:00:00Z' });
  return dir;
}

describe('syncIndex', () => {
  it('projects the git store into the SQLite index', async () => {
    await withTempDirAsync(async (store) => {
      await seed(store, 's1');
      await seed(store, 's2');
      const cfg = makeConfig(store);

      const stats = syncIndex(cfg);
      expect(stats.total).toBe(2);
      expect(stats.indexed).toBe(2);

      const idx = new SessionIndex(cfg.indexPath);
      try {
        expect(idx.stats().sessions).toBe(2);
        expect(idx.searchTurns('parser').length).toBeGreaterThan(0);
        expect(idx.listRecent(10)[0]!.topic).toContain('fix the parser bug');
      } finally {
        idx.close();
      }
    });
  });

  it('is incremental (unchanged on re-sync) and removes deleted sessions', async () => {
    await withTempDirAsync(async (store) => {
      const dir = await seed(store, 's1');
      await seed(store, 's2');
      const cfg = makeConfig(store);
      syncIndex(cfg);

      const again = syncIndex(cfg);
      expect(again.indexed).toBe(0);
      expect(again.unchanged).toBe(2);

      rmSync(dir, { recursive: true, force: true });
      const after = syncIndex(cfg);
      expect(after.removed).toBe(1);
      const idx = new SessionIndex(cfg.indexPath);
      try {
        expect(idx.stats().sessions).toBe(1);
      } finally {
        idx.close();
      }
    });
  });
});
