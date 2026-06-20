import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaptureEngine } from './capture';
import { StateStore } from './state';
import { envelopeFile, sessionDir, turnFile } from './store/paths';
import { makeConfig, withTempDir } from './test/tmp';

const LINES = [
  '{"type":"user","sessionId":"sess-1","cwd":"/proj","gitBranch":"main","timestamp":"2026-06-20T08:00:00Z","message":{"role":"user","content":"hi"}}',
  '{"type":"assistant","timestamp":"2026-06-20T08:00:05Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"hello"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a"}}],"usage":{"input_tokens":1000,"output_tokens":20}}}',
];

function writeTranscript(dir: string, lines: string[]): string {
  const p = join(dir, 'sess-1.jsonl');
  writeFileSync(p, lines.map((l) => `${l}\n`).join(''));
  return p;
}

describe('CaptureEngine', () => {
  it('captures turns into immutable per-turn files + envelope', () => {
    withTempDir((root) => {
      const store = join(root, 'store');
      const src = join(root, 'src');
      mkdirSync(src, { recursive: true });
      const cfg = makeConfig(store);
      const engine = new CaptureEngine(cfg, new StateStore(join(store, 'state.json')));
      const transcript = writeTranscript(src, LINES);

      const res = engine.captureSession('sess-1', transcript);
      expect(res.newTurns).toBe(2);
      expect(res.month).toBe('2026-06');

      const dir = sessionDir(store, 'test-host', '2026-06', 'sess-1');
      expect(existsSync(turnFile(dir, 0))).toBe(true);
      expect(existsSync(turnFile(dir, 1))).toBe(true);
      expect(existsSync(envelopeFile(dir))).toBe(true);
      expect(res.envelope!.turn_count).toBe(2);
      expect(res.envelope!.model).toBe('claude-opus-4-8');
      expect(res.envelope!.tool_call_count).toBe(1);
      expect(res.envelope!.totals.cost_usd).toBeGreaterThan(0);
    });
  });

  it('is incremental: a second call only captures appended turns', () => {
    withTempDir((root) => {
      const store = join(root, 'store');
      const src = join(root, 'src');
      mkdirSync(src, { recursive: true });
      const cfg = makeConfig(store);
      const state = new StateStore(join(store, 'state.json'));
      const engine = new CaptureEngine(cfg, state);
      const transcript = writeTranscript(src, LINES);

      const r1 = engine.captureSession('sess-1', transcript);
      expect(r1.newTurns).toBe(2);

      // append one more assistant turn
      writeFileSync(
        transcript,
        LINES.map((l) => `${l}\n`).join('') +
          '{"type":"assistant","timestamp":"2026-06-20T08:01:00Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":50,"output_tokens":5}}}\n',
      );

      const r2 = engine.captureSession('sess-1', transcript);
      expect(r2.newTurns).toBe(1);
      const dir = sessionDir(store, 'test-host', '2026-06', 'sess-1');
      expect(existsSync(turnFile(dir, 2))).toBe(true);
      expect(r2.envelope!.turn_count).toBe(3);
    });
  });

  it('is restart-safe: a fresh engine resumes from persisted offset', () => {
    withTempDir((root) => {
      const store = join(root, 'store');
      const src = join(root, 'src');
      mkdirSync(src, { recursive: true });
      const cfg = makeConfig(store);
      const statePath = join(store, 'state.json');
      const transcript = writeTranscript(src, LINES);

      new CaptureEngine(cfg, new StateStore(statePath)).captureSession('sess-1', transcript);
      // simulate restart with a brand-new engine + state loaded from disk
      const r = new CaptureEngine(cfg, new StateStore(statePath)).captureSession('sess-1', transcript);
      expect(r.newTurns).toBe(0); // nothing new; no duplicate turns
    });
  });

  it('scrubs secrets during capture', () => {
    withTempDir((root) => {
      const store = join(root, 'store');
      const src = join(root, 'src');
      mkdirSync(src, { recursive: true });
      const cfg = makeConfig(store);
      const engine = new CaptureEngine(cfg, new StateStore(join(store, 'state.json')));
      const line =
        '{"type":"user","sessionId":"sess-2","timestamp":"2026-06-20T08:00:00Z","message":{"role":"user","content":"my key ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD ok"}}';
      const transcript = writeTranscript(src, [line]);
      const res = engine.captureSession('sess-2', transcript);
      expect(res.redactions).toBeGreaterThan(0);
    });
  });
});
