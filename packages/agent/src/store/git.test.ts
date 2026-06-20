import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '../test/tmp';
import { GitStore } from './git';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function writeFile(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

describe('GitStore basics', () => {
  it('initializes a repo with scaffolding (idempotent)', () => {
    withTempDir((dir) => {
      const store = new GitStore(dir);
      store.init();
      expect(store.isRepo()).toBe(true);
      expect(existsSync(join(dir, '.gitignore'))).toBe(true);
      expect(existsSync(join(dir, '.gitattributes'))).toBe(true);
      expect(() => store.init()).not.toThrow(); // idempotent
    });
  });

  it('commits content and reports clean trees', () => {
    withTempDir((dir) => {
      const store = new GitStore(dir);
      store.init();
      expect(store.commit('init').committed).toBe(true); // .gitignore/.gitattributes
      expect(store.commit('noop').committed).toBe(false); // clean now

      writeFile(dir, 'hosts/A/2026-06/s1/turns/000000.json', '{"a":1}');
      const c = store.commit('add turn');
      expect(c.committed).toBe(true);
      expect(c.sha).toMatch(/^[0-9a-f]{7,40}$/);
    });
  });

  it('ignores runtime (.daemon) and raw/ blobs', () => {
    withTempDir((dir) => {
      const store = new GitStore(dir);
      store.init();
      store.commit('init');
      writeFile(dir, '.daemon/state.json', '{}');
      writeFile(dir, 'hosts/A/2026-06/s1/raw/deadbeef', 'huge');
      expect(store.hasChanges()).toBe(false); // both ignored
    });
  });
});

describe('GitStore two-host conflict-free sync', () => {
  it('merges host-keyed writes from two machines with no conflict', () => {
    withTempDir((root) => {
      const remote = join(root, 'remote.git');
      mkdirSync(remote, { recursive: true });
      git(remote, 'init', '--bare', '-b', 'main');

      // Host A: init, write, push
      const dirA = join(root, 'hostA');
      mkdirSync(dirA, { recursive: true });
      const a = new GitStore(dirA, { remote, autoPush: true });
      a.init();
      writeFile(dirA, 'hosts/A/2026-06/sa/turns/000000.json', '{"host":"A"}');
      const ra = a.sync('A: turn 0');
      expect(ra.commit.committed).toBe(true);
      expect(ra.pushed).toBe(true);

      // Host B: clone, write a DIFFERENT host path, sync (pull --rebase + push)
      const dirB = join(root, 'hostB');
      git(root, 'clone', remote, dirB);
      const b = new GitStore(dirB, { remote, autoPush: true });
      b.init();
      writeFile(dirB, 'hosts/B/2026-06/sb/turns/000000.json', '{"host":"B"}');
      const rb = b.sync('B: turn 0');
      expect(rb.commit.committed).toBe(true);
      expect(rb.pushed).toBe(true);

      // Host A: new write, must pull B's commit (rebase) then push — still clean
      writeFile(dirA, 'hosts/A/2026-06/sa/turns/000001.json', '{"host":"A2"}');
      const ra2 = a.sync('A: turn 1');
      expect(ra2.commit.committed).toBe(true);
      expect(ra2.pushed).toBe(true);

      // Fresh clone sees ALL three files — nothing was lost or conflicted
      const verify = join(root, 'verify');
      git(root, 'clone', remote, verify);
      expect(existsSync(join(verify, 'hosts/A/2026-06/sa/turns/000000.json'))).toBe(true);
      expect(existsSync(join(verify, 'hosts/A/2026-06/sa/turns/000001.json'))).toBe(true);
      expect(existsSync(join(verify, 'hosts/B/2026-06/sb/turns/000000.json'))).toBe(true);
    });
  });
});
