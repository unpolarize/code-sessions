import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdBackfill, cmdDoctor, cmdInit, cmdInstallHooks, cmdReindex, cmdStatus, listClaudeTranscripts } from './commands';
import { insightsFile, sessionDir } from './store/paths';
import { makeConfig, withTempDir, withTempDirAsync } from './test/tmp';

const LINES = [
  '{"type":"user","sessionId":"sess-1","cwd":"/proj","timestamp":"2026-06-20T08:00:00Z","message":{"role":"user","content":"Fix the bug in foo.ts"}}',
  '{"type":"assistant","timestamp":"2026-06-20T08:00:05Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"t","name":"Edit","input":{}}],"usage":{"input_tokens":100,"output_tokens":10}}}',
];

function seedProjects(root: string): string {
  const projects = join(root, 'projects', 'encoded');
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, 'sess-1.jsonl'), LINES.map((l) => `${l}\n`).join(''));
  return join(root, 'projects');
}

describe('listClaudeTranscripts', () => {
  it('finds session files recursively', () => {
    withTempDir((root) => {
      const projectsDir = seedProjects(root);
      const found = listClaudeTranscripts(projectsDir);
      expect(found).toHaveLength(1);
      expect(found[0]!.sessionId).toBe('sess-1');
    });
  });
});

describe('cmdInit', () => {
  it('initializes the store repo and config', () => {
    withTempDir((root) => {
      const store = join(root, 'store');
      const res = cmdInit(makeConfig(store));
      expect(res.code).toBe(0);
      expect(existsSync(join(store, '.git'))).toBe(true);
      expect(existsSync(join(store, 'config.json'))).toBe(true);
    });
  });
});

describe('cmdBackfill', () => {
  it('imports existing transcripts into the store', async () => {
    await withTempDirAsync(async (root) => {
      const store = join(root, 'store');
      const projectsDir = seedProjects(root);
      const res = await cmdBackfill(makeConfig(store), { projectsDir });
      expect(res.code).toBe(0);
      expect(res.output).toMatch(/Backfilled 1 session/);
      const dir = sessionDir(store, 'test-host', '2026-06', 'sess-1');
      expect(existsSync(dir)).toBe(true);
    });
  });
});

describe('cmdReindex', () => {
  it('derives insights for backfilled sessions', async () => {
    await withTempDirAsync(async (root) => {
      const store = join(root, 'store');
      const projectsDir = seedProjects(root);
      const cfg = makeConfig(store, { insights: { provider: 'fake' } });
      await cmdBackfill(cfg, { projectsDir });
      const res = await cmdReindex(cfg);
      expect(res.output).toMatch(/Reindexed 1 session.*provider=fake/);
      const dir = sessionDir(store, 'test-host', '2026-06', 'sess-1');
      expect(existsSync(insightsFile(dir))).toBe(true);
    });
  });
});

describe('cmdInstallHooks', () => {
  it('writes hooks into a target settings file', () => {
    withTempDir((root) => {
      const settingsPath = join(root, 'settings.json');
      const res = cmdInstallHooks(makeConfig(join(root, 'store')), { settingsPath });
      expect(res.code).toBe(0);
      const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(written.hooks.Stop[0].hooks[0].command).toBe('code-sessions hook');
    });
  });
});

describe('cmdStatus / cmdDoctor', () => {
  it('status reports store + provider config', () => {
    withTempDir((root) => {
      const res = cmdStatus(makeConfig(join(root, 'store'), { insights: { provider: 'fake' } }));
      expect(res.output).toMatch(/insights:\s+fake/);
    });
  });

  it('status reports the codex/grok source-watch config', () => {
    withTempDir((root) => {
      const res = cmdStatus(makeConfig(join(root, 'store'), { capture: { watch: { codex: true, grok: false, intervalMs: 30000 } } }));
      expect(res.output).toMatch(/watch:\s+codex/);
      expect(res.output).not.toMatch(/grok/);
    });
  });

  it('doctor returns non-zero when store is missing', () => {
    withTempDir((root) => {
      const res = cmdDoctor(makeConfig(join(root, 'absent')));
      expect(res.code).toBe(1);
      expect(res.output).toMatch(/✗ store dir exists/);
    });
  });
});
