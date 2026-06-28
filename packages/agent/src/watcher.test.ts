import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from './state';
import { listSessionDirs } from './store/scan';
import { makeConfig, withTempDir } from './test/tmp';
import { SourceWatcher } from './watcher';

/** Seed a grok session dir tree under `root` and return the chat file path. */
function seedGrok(root: string, id = 'gg-1'): string {
  const dir = join(root, '%2FUsers%2Fx%2Fprojects%2Ffoo', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({ created_at: '2026-06-20T08:00:00Z', generated_title: 'Fix foo', current_model_id: 'grok-build', info: { cwd: '/Users/x/projects/foo' } }),
  );
  const chat = join(dir, 'chat_history.jsonl');
  writeFileSync(
    chat,
    [
      '{"type":"user","content":"Fix the bug in foo.ts"}',
      '{"type":"assistant","content":"on it","model_id":"grok-build","tool_calls":[]}',
    ].join('\n'),
  );
  return chat;
}

/** Seed a codex rollout under `root` and return the rollout file path. */
function seedCodex(root: string, id = '11111111-2222-3333-4444-555555555555'): string {
  const dir = join(root, '2026', '06', '20');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-06-20T09-00-00-${id}.jsonl`);
  writeFileSync(
    file,
    [
      `{"timestamp":"2026-06-20T09:00:00Z","type":"session_meta","payload":{"id":"${id}","timestamp":"2026-06-20T09:00:00Z","model":"gpt-5-codex","cwd":"/Users/x/proj"}}`,
      '{"timestamp":"2026-06-20T09:00:03Z","type":"event_msg","payload":{"type":"user_message","message":"print 42"}}',
      '{"timestamp":"2026-06-20T09:00:05Z","type":"event_msg","payload":{"type":"agent_message","message":"42"}}',
    ].join('\n'),
  );
  return file;
}

describe('SourceWatcher', () => {
  it('imports new codex + grok sessions into the store, skipping unchanged ones on re-scan', () => {
    withTempDir((root) => {
      const store = join(root, 'store');
      const grokRoot = join(root, 'grok');
      const codexRoot = join(root, 'codex');
      seedGrok(grokRoot);
      seedCodex(codexRoot);

      const cfg = makeConfig(store, { capture: { watch: { codex: true, grok: true } } });
      const state = new StateStore(cfg.statePath);
      const watcher = new SourceWatcher(cfg, state, { grokRoot, codexRoot });

      const first = watcher.scanOnce();
      expect(first.imported).toBe(2);
      expect(first.turns).toBeGreaterThan(0);
      expect(listSessionDirs(store).length).toBe(2);

      // Re-scan with nothing changed → nothing re-imported.
      const second = watcher.scanOnce();
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(2);
    });
  });

  it('re-imports a session after its source file changes', () => {
    withTempDir((root) => {
      const store = join(root, 'store');
      const codexRoot = join(root, 'codex');
      const file = seedCodex(codexRoot);

      const cfg = makeConfig(store, { capture: { watch: { codex: true, grok: false } } });
      const watcher = new SourceWatcher(cfg, new StateStore(cfg.statePath), { codexRoot, grokRoot: join(root, 'none') });

      expect(watcher.scanOnce().imported).toBe(1);
      // Appending changes size → fingerprint changes → re-import.
      appendFileSync(file, '\n{"timestamp":"2026-06-20T09:00:06Z","type":"event_msg","payload":{"type":"user_message","message":"again"}}');
      expect(watcher.scanOnce().imported).toBe(1);
    });
  });

  it('ignores sources disabled in config', () => {
    withTempDir((root) => {
      const store = join(root, 'store');
      const grokRoot = join(root, 'grok');
      const codexRoot = join(root, 'codex');
      seedGrok(grokRoot);
      seedCodex(codexRoot);

      const cfg = makeConfig(store, { capture: { watch: { codex: false, grok: true } } });
      const watcher = new SourceWatcher(cfg, new StateStore(cfg.statePath), { grokRoot, codexRoot });

      const r = watcher.scanOnce();
      expect(r.imported).toBe(1); // grok only
      expect(r.perAgent.codex.imported).toBe(0);
      expect(r.perAgent.grok.imported).toBe(1);
    });
  });
});
