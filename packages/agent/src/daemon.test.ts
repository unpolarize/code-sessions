import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Daemon, findTranscript } from './daemon';
import { sendEvent } from './ipc';
import { sessionDir, turnFile } from './store/paths';
import { makeConfig, withTempDir } from './test/tmp';
import { StateStore } from './state';
import { SourceWatcher } from './watcher';

const LINES = [
  '{"type":"user","sessionId":"sess-1","cwd":"/proj","gitBranch":"main","timestamp":"2026-06-20T08:00:00Z","message":{"role":"user","content":"hi"}}',
  '{"type":"assistant","timestamp":"2026-06-20T08:00:05Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":1000,"output_tokens":20}}}',
];

function writeTranscript(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'sess-1.jsonl');
  writeFileSync(p, LINES.map((l) => `${l}\n`).join(''));
  return p;
}

function gitLogCount(repo: string): number {
  const r = spawnSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' });
  if (r.status !== 0) return 0;
  return r.stdout.trim().split('\n').filter(Boolean).length;
}

describe('findTranscript', () => {
  it('locates a session file by id under the projects dir', () => {
    withTempDir((root) => {
      const proj = join(root, 'projects', 'encoded-proj');
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, 'abc-123.jsonl'), '{}');
      expect(findTranscript(join(root, 'projects'), 'abc-123')).toBe(join(proj, 'abc-123.jsonl'));
      expect(findTranscript(join(root, 'projects'), 'missing')).toBeUndefined();
    });
  });
});

describe('Daemon', () => {
  it('captures via handleEvent and commits on flush', async () => {
    await withTempDirAsync(async (root) => {
      const store = join(root, 'store');
      const transcript = writeTranscript(join(root, 'src'));
      const d = new Daemon(makeConfig(store, { batch: { maxTurns: 1 } }));
      await d.start();
      const ack = await d.handleEvent({
        event: 'PostToolUse',
        session_id: 'sess-1',
        transcript_path: transcript,
      });
      expect(ack.ok).toBe(true);
      expect(ack.newTurns).toBe(2);
      expect(ack.flushed).toBe(true); // maxTurns=1 forces a flush
      await d.stop();

      const dir = sessionDir(store, 'test-host', '2026-06', 'sess-1');
      expect(existsSync(turnFile(dir, 0))).toBe(true);
      expect(gitLogCount(store)).toBeGreaterThanOrEqual(1);
    });
  });

  it('accepts events over the unix socket', async () => {
    await withTempDirAsync(async (root) => {
      const store = join(root, 'store');
      const transcript = writeTranscript(join(root, 'src'));
      const socketPath = join(root, 'd.sock');
      const d = new Daemon(makeConfig(store, { socketPath, batch: { maxTurns: 1 } }));
      await d.start();
      try {
        const ack = await sendEvent(socketPath, {
          event: 'PostToolUse',
          session_id: 'sess-1',
          transcript_path: transcript,
        });
        expect(ack.ok).toBe(true);
        expect(ack.newTurns).toBe(2);
      } finally {
        await d.stop();
      }
    });
  });

  it('reports an error when the transcript cannot be found', async () => {
    await withTempDirAsync(async (root) => {
      const d = new Daemon(makeConfig(join(root, 'store')));
      await d.start();
      try {
        const ack = await d.handleEvent({
          event: 'PostToolUse',
          session_id: 'nope',
          transcript_path: '/does/not/exist.jsonl',
        });
        expect(ack.ok).toBe(false);
        expect(ack.error).toMatch(/not found/);
      } finally {
        await d.stop();
      }
    });
  });

  it('invokes the onSessionEnd hook on Stop', async () => {
    await withTempDirAsync(async (root) => {
      const store = join(root, 'store');
      const transcript = writeTranscript(join(root, 'src'));
      const onSessionEnd = vi.fn();
      const d = new Daemon(makeConfig(store), { onSessionEnd });
      await d.start();
      await d.handleEvent({ event: 'Stop', session_id: 'sess-1', transcript_path: transcript });
      await d.stop();
      expect(onSessionEnd).toHaveBeenCalledOnce();
      expect(onSessionEnd).toHaveBeenCalledWith(
        'sess-1',
        sessionDir(store, 'test-host', '2026-06', 'sess-1'),
      );
    });
  });
});

describe('Daemon source watcher', () => {
  it('imports codex sessions via an injected watcher and commits them', async () => {
    await withTempDirAsync(async (root) => {
      const store = join(root, 'store');
      const codexRoot = join(root, 'codex');
      const dir = join(codexRoot, '2026', '06', '20');
      mkdirSync(dir, { recursive: true });
      const id = '11111111-2222-3333-4444-555555555555';
      writeFileSync(
        join(dir, `rollout-2026-06-20T09-00-00-${id}.jsonl`),
        [
          `{"timestamp":"2026-06-20T09:00:00Z","type":"session_meta","payload":{"id":"${id}","timestamp":"2026-06-20T09:00:00Z","model":"gpt-5-codex","cwd":"/x"}}`,
          '{"timestamp":"2026-06-20T09:00:03Z","type":"event_msg","payload":{"type":"user_message","message":"hi"}}',
          '{"timestamp":"2026-06-20T09:00:05Z","type":"event_msg","payload":{"type":"agent_message","message":"yo"}}',
        ].join('\n'),
      );

      const cfg = makeConfig(store, { capture: { watch: { codex: true, grok: false, intervalMs: 999999 } } });
      const state = new StateStore(cfg.statePath);
      const watcher = new SourceWatcher(cfg, state, { codexRoot, grokRoot: join(root, 'none') });
      const d = new Daemon(cfg, { state, watcher });
      await d.start(); // start() runs an immediate watcher scan
      await d.stop(); // flushes the imported session

      const sdir = sessionDir(store, 'test-host', '2026-06', id);
      expect(existsSync(turnFile(sdir, 0))).toBe(true);
      expect(gitLogCount(store)).toBeGreaterThanOrEqual(1);
    });
  });
});

// async temp-dir helper (mirror of withTempDir but awaits fn)
async function withTempDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'cs-d-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
