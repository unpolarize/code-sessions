import { describe, expect, it } from 'vitest';
import { TaskRegistry } from './tasks';

describe('TaskRegistry', () => {
  it('tracks running → finished with elapsed and caps recent', () => {
    let t = 1000;
    const r = new TaskRegistry(2, () => t);
    r.start('backfill:grok', 'grok backfill');
    r.progress('backfill:grok', 100, 382);
    t = 5000;
    r.finish('backfill:grok', { detail: '382 sessions' });
    const l = r.list();
    expect(l.running).toEqual([]);
    expect(l.recent[0]!).toMatchObject({ phase: 'ok', endedMs: 4000, detail: '382 sessions' });
    r.record('watcher.scan', { detail: 'imported 2' });
    r.record('store.flush', { error: 'push failed' });
    expect(r.list().recent.map((x) => x.title)).toEqual(['store.flush', 'watcher.scan']);
    expect(r.list().recent[0]!.phase).toBe('error');
  });

  it('watcher heartbeat is reported', () => {
    const r = new TaskRegistry(5, () => 42);
    expect(r.list().watcher).toBeUndefined();
    r.watcherScan(30000);
    expect(r.list().watcher).toEqual({ lastScanAt: 42, intervalMs: 30000 });
  });
});
