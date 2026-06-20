import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionDir, turnFile, envelopeFile } from '../store/paths';
import { makeConfig, withTempDir } from '../test/tmp';
import { discoverCodexSessions, parseCodexSession } from './codex';
import { discoverGrokSessions, parseGrokSession } from './grok';
import { writeImportedSession } from './import';

function seedGrok(root: string): void {
  const dir = join(root, '%2FUsers%2Fx%2Fprojects%2Ffoo', 'gg-uuid-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      created_at: '2026-06-20T08:00:00Z',
      generated_title: 'Fix foo bug',
      current_model_id: 'grok-build',
      info: { cwd: '/Users/x/projects/foo' },
    }),
  );
  writeFileSync(
    join(dir, 'chat_history.jsonl'),
    [
      '{"type":"system","content":"sys"}',
      '{"type":"user","content":"Fix the bug in foo.ts"}',
      '{"type":"reasoning","summary":"thinking"}',
      '{"type":"assistant","content":"I\'ll edit it","model_id":"grok-build","tool_calls":[{"id":"c1","name":"Read","arguments":"{\\"path\\":\\"/Users/x/projects/foo/a.ts\\"}"}]}',
      '{"type":"tool_result","tool_call_id":"c1","content":"file contents"}',
    ].join('\n'),
  );
}

describe('grok adapter', () => {
  it('discovers and parses a grok session into canonical turns', () => {
    withTempDir((root) => {
      seedGrok(root);
      const found = discoverGrokSessions(root);
      expect(found).toHaveLength(1);
      const imported = parseGrokSession(found[0]!, 'test-host')!;
      expect(imported.agent).toBe('grok');
      expect(imported.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'tool']);
      expect(imported.turns[1]!.tool_calls[0]).toMatchObject({ name: 'Read' });
      expect(imported.meta.model).toBe('grok-build');
      expect(imported.meta.title).toBe('Fix foo bug');
      expect(imported.meta.started_at).toBe('2026-06-20T08:00:00.000Z');
    });
  });

  it('skips claude_import grok sessions', () => {
    withTempDir((root) => {
      const dir = join(root, '%2Fx', 'ci');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'summary.json'), JSON.stringify({ session_kind: 'claude_import' }));
      writeFileSync(join(dir, 'chat_history.jsonl'), '{"type":"user","content":"hi"}');
      expect(parseGrokSession(discoverGrokSessions(root)[0]!, 'h')).toBeNull();
    });
  });
});

function seedCodex(root: string): void {
  const dir = join(root, '2026', '06', '20');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'rollout-2026-06-20T09-00-00-11111111-2222-3333-4444-555555555555.jsonl'),
    [
      '{"timestamp":"2026-06-20T09:00:00Z","type":"session_meta","payload":{"type":"session_meta","id":"11111111-2222-3333-4444-555555555555","model":"gpt-5-codex","cwd":"/Users/x/proj"}}',
      '{"timestamp":"2026-06-20T09:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"print 42"}]}}',
      '{"timestamp":"2026-06-20T09:00:02Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\\"command\\":\\"echo 42\\"}"}}',
      '{"timestamp":"2026-06-20T09:00:03Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"42"}]}}',
    ].join('\n'),
  );
}

describe('codex adapter', () => {
  it('discovers and parses a codex rollout into canonical turns', () => {
    withTempDir((root) => {
      seedCodex(root);
      const found = discoverCodexSessions(root);
      expect(found).toHaveLength(1);
      expect(found[0]!.sessionId).toBe('11111111-2222-3333-4444-555555555555');
      const imported = parseCodexSession(found[0]!, 'test-host')!;
      expect(imported.agent).toBe('codex');
      expect(imported.meta.model).toBe('gpt-5-codex');
      expect(imported.meta.project_path).toBe('/Users/x/proj');
      expect(imported.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'assistant']);
      expect(imported.turns[1]!.tool_calls[0]).toMatchObject({ name: 'shell' });
      expect(imported.turns[2]!.text).toBe('42');
    });
  });
});

describe('writeImportedSession', () => {
  it('writes per-turn files + envelope for an imported session', () => {
    withTempDir((store) => {
      seedGrokInStore(store);
    });
  });
});

function seedGrokInStore(store: string): void {
  const grokRoot = join(store, 'grok');
  seedGrok(grokRoot);
  const imported = parseGrokSession(discoverGrokSessions(grokRoot)[0]!, 'other-host')!;
  const cfg = makeConfig(store);
  const res = writeImportedSession(cfg, imported);
  const dir = sessionDir(store, 'other-host', '2026-06', 'gg-uuid-1');
  expect(res.sessionDir).toBe(dir);
  expect(existsSync(turnFile(dir, 0))).toBe(true);
  expect(existsSync(envelopeFile(dir))).toBe(true);
  expect(res.envelope.agent).toBe('grok');
  expect(res.envelope.native_ref.format).toBe('grok-jsonl');
}
