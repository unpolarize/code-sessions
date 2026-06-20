import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from './state';
import { withTempDir } from './test/tmp';

describe('StateStore', () => {
  it('initializes and persists a session', () => {
    withTempDir((dir) => {
      const path = join(dir, 'state.json');
      const store = new StateStore(path);
      const s = store.ensure('sess-1', '/tmp/sess-1.jsonl');
      expect(s.offset).toBe(0);
      expect(s.nextTurnIndex).toBe(0);
      expect(existsSync(path)).toBe(true);
    });
  });

  it('survives reload (restart-safe)', () => {
    withTempDir((dir) => {
      const path = join(dir, 'state.json');
      const a = new StateStore(path);
      a.ensure('sess-1', '/tmp/sess-1.jsonl');
      a.update('sess-1', { offset: 128, nextTurnIndex: 4, month: '2026-06' });

      const b = new StateStore(path);
      const s = b.get('sess-1');
      expect(s).toBeDefined();
      expect(s!.offset).toBe(128);
      expect(s!.nextTurnIndex).toBe(4);
      expect(s!.month).toBe('2026-06');
    });
  });

  it('recovers from a corrupt state file', () => {
    withTempDir((dir) => {
      const path = join(dir, 'state.json');
      writeFileSync(path, 'not json at all');
      const store = new StateStore(path);
      expect(store.all()).toEqual({});
      // still usable
      store.ensure('x', '/tmp/x.jsonl');
      expect(store.get('x')).toBeDefined();
    });
  });
});
