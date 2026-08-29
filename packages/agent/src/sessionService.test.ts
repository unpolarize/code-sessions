import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eventsFile, sessionDir } from './store/paths';
import { monthOf } from './store/paths';
import { SessionService } from './sessionService';
import { makeConfig, withTempDir } from './test/tmp';

describe('SessionService', () => {
  it('creates an envelope under hosts/host/month/id and lists by cwd', () => {
    withTempDir((root) => {
      const store = `${root}/store`;
      const svc = new SessionService(makeConfig(store));
      const { id } = svc.create({
        backend: 'grok',
        cwd: '/Users/me/proj-a',
        title: 'session A',
        model: 'grok-4',
      });
      expect(id).toMatch(/[0-9a-f-]{8,}/);
      const env = svc.get(id);
      expect(env?.project_path).toBe('/Users/me/proj-a');
      expect(env?.backend).toBe('grok');
      expect(env?.agent).toBe('grok');
      expect(env?.hasContent).toBe(false);
      const dir = sessionDir(store, 'test-host', monthOf(env?.started_at), id);
      expect(existsSync(`${dir}/session.json`)).toBe(true);

      svc.create({ backend: 'claude', cwd: '/Users/me/proj-b', title: 'session B' });
      const a = svc.list({ filter: { cwd: '/Users/me/proj-a' } });
      expect(a.sessions).toHaveLength(1);
      expect(a.sessions[0]?.id).toBe(id);
      const none = svc.list({ filter: { cwd: '/Users/me/other' } });
      expect(none.sessions).toHaveLength(0);
    });
  });

  it('patchMeta writes the envelope only and append/replay uses events.ndjson', () => {
    withTempDir((root) => {
      const store = `${root}/store`;
      const svc = new SessionService(makeConfig(store));
      const { id } = svc.create({ cwd: '/ws', title: 't' });
      svc.patchMeta(id, { title: 'renamed', hasContent: true });
      expect(svc.get(id)?.title).toBe('renamed');

      const e1 = svc.append(id, { kind: 'user', text: 'hi' }, 1000);
      const e2 = svc.append(id, { kind: 'assistant', text: 'yo' }, 2000);
      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
      const found = svc.locate(id)!;
      expect(existsSync(eventsFile(found.dir))).toBe(true);
      const raw = readFileSync(eventsFile(found.dir), 'utf8').trim().split('\n');
      expect(raw).toHaveLength(2);

      const replay = svc.replay(id, 2);
      expect(replay.events).toHaveLength(1);
      expect(replay.events[0]?.seq).toBe(2);
      expect(svc.get(id)?.hasContent).toBe(true);
      expect(svc.get(id)?.event_seq).toBe(2);
    });
  });

  it('onEvent fires for append and not for create', () => {
    withTempDir((root) => {
      const svc = new SessionService(makeConfig(`${root}/store`));
      const seen: Array<{ id: string; seq: number }> = [];
      svc.onEvent((id, rec) => seen.push({ id, seq: rec.seq }));
      const { id } = svc.create({ cwd: '/ws' });
      expect(seen).toHaveLength(0);
      svc.append(id, { kind: 'user', text: 'hi' }, 1);
      expect(seen).toEqual([{ id, seq: 1 }]);
    });
  });

  it('list hasContent filter hides empty creates', () => {
    withTempDir((root) => {
      const svc = new SessionService(makeConfig(`${root}/store`));
      const empty = svc.create({ cwd: '/ws' });
      const live = svc.create({ cwd: '/ws' });
      svc.append(live.id, { kind: 'user', text: 'x' });
      const withContent = svc.list({ filter: { cwd: '/ws', hasContent: true } });
      expect(withContent.sessions.map((s) => s.id)).toEqual([live.id]);
      expect(withContent.sessions.find((s) => s.id === empty.id)).toBeUndefined();
    });
  });
});
