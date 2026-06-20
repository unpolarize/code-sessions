import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '../commands';
import { sendEvent } from '../ipc';
import { envelopeFile, insightsFile, sessionDir, turnFile } from '../store/paths';
import { makeConfig, withTempDirAsync } from './tmp';

const BIN = fileURLToPath(new URL('../../bin/code-sessions.mjs', import.meta.url));

const USER =
  '{"type":"user","sessionId":"e2e","cwd":"/p","timestamp":"2026-06-20T08:00:00Z","message":{"role":"user","content":"Fix the bug in foo.ts"}}';
const ASSISTANT =
  '{"type":"assistant","timestamp":"2026-06-20T08:00:05Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"t","name":"Edit","input":{}}],"usage":{"input_tokens":1000,"output_tokens":20}}}';
const DONE =
  '{"type":"assistant","timestamp":"2026-06-20T08:01:00Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":50,"output_tokens":5}}}';

function gitLogCount(repo: string): number {
  const r = spawnSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean).length : 0;
}

describe('e2e: live capture pipeline (socket + insights on Stop)', () => {
  it('captures turns, derives insights, and commits — across hook events', async () => {
    await withTempDirAsync(async (root) => {
      const store = join(root, 'store');
      const src = join(root, 'src');
      mkdirSync(src, { recursive: true });
      const transcript = join(src, 'e2e.jsonl');
      writeFileSync(transcript, `${USER}\n${ASSISTANT}\n`);

      const cfg = makeConfig(store, {
        socketPath: join(root, 'd.sock'),
        insights: { provider: 'fake', mode: 'on-stop' },
      });
      const daemon = await startDaemon(cfg);
      try {
        const a1 = await sendEvent(cfg.socketPath, {
          event: 'PostToolUse',
          session_id: 'e2e',
          transcript_path: transcript,
        });
        expect(a1.ok).toBe(true);
        expect(a1.newTurns).toBe(2);

        appendFileSync(transcript, `${DONE}\n`);
        const a2 = await sendEvent(cfg.socketPath, {
          event: 'Stop',
          session_id: 'e2e',
          transcript_path: transcript,
        });
        expect(a2.ok).toBe(true);
        expect(a2.newTurns).toBe(1);
        expect(a2.flushed).toBe(true);
      } finally {
        await daemon.stop();
      }

      const dir = sessionDir(store, cfg.host, '2026-06', 'e2e');
      expect(existsSync(turnFile(dir, 0))).toBe(true);
      expect(existsSync(turnFile(dir, 2))).toBe(true);

      const env = JSON.parse(readFileSync(envelopeFile(dir), 'utf8'));
      expect(env.turn_count).toBe(3);
      expect(env.model).toBe('claude-opus-4-8');

      const insights = JSON.parse(readFileSync(insightsFile(dir), 'utf8'));
      expect(insights.provider).toBe('fake');
      expect(insights.topic).toContain('Fix the bug');
      expect(insights.tags).toContain('Edit');

      expect(gitLogCount(store)).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('e2e: CLI binary (backfill -> reindex -> analytics -> status)', () => {
  it('runs the real bin against a fixture projects dir', async () => {
    await withTempDirAsync(async (root) => {
      const store = join(root, 'store');
      const projects = join(root, 'projects', 'enc');
      mkdirSync(projects, { recursive: true });
      writeFileSync(join(projects, 'cli-1.jsonl'), `${USER}\n${ASSISTANT}\n${DONE}\n`);

      const run = (...args: string[]) =>
        spawnSync(process.execPath, [BIN, ...args, '--store', store, '--host', 'cli-host'], {
          encoding: 'utf8',
        });

      const backfill = run('backfill', '--projects', join(root, 'projects'));
      expect(backfill.status).toBe(0);
      expect(backfill.stdout).toMatch(/Backfilled 1 session/);

      const reindex = run('reindex', '--provider', 'fake');
      expect(reindex.status).toBe(0);
      expect(reindex.stdout).toMatch(/Reindexed 1 session/);

      const analytics = run('analytics');
      expect(analytics.status).toBe(0);

      const status = run('status');
      expect(status.status).toBe(0);
      expect(status.stdout).toMatch(/stored:\s+1 session/);

      const dir = sessionDir(store, 'cli-host', '2026-06', 'cli-1');
      expect(existsSync(insightsFile(dir))).toBe(true);
      expect(existsSync(join(store, 'analytics', 'report.json'))).toBe(true);
    });
  }, 30000);
});
