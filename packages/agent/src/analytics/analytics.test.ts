import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Turn } from '@unpolarize/code-sessions-schema';
import { FakeProvider } from '../insights/provider';
import { labelSession } from '../insights/labeler';
import { sessionDir } from '../store/paths';
import { rebuildEnvelope, writeTurnFile } from '../store/writer';
import { makeConfig, withTempDirAsync } from '../test/tmp';
import { cmdAnalytics } from './command';
import { renderDigest } from './digest';
import { computeReport } from './rollup';
import { renderSite } from './site';

function turn(i: number, over: Partial<Turn> = {}): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 's',
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: `2026-06-20T08:0${i}:00Z`,
    role: 'assistant',
    text: '',
    tool_calls: [],
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

async function seed(store: string, sessionId: string): Promise<void> {
  const dir = sessionDir(store, 'h', '2026-06', sessionId);
  writeTurnFile(dir, turn(0, { role: 'user', text: 'Fix the bug in foo.ts' }));
  writeTurnFile(dir, turn(1, { tool_calls: [{ name: 'Edit' }], telemetry: { cost_usd: 0.9 } }));
  rebuildEnvelope(store, 'h', '2026-06', sessionId, { model: 'claude-opus-4-8' }, {
    session_id: sessionId,
    host: 'h',
    agent: 'claude-code',
    native_uuid: sessionId,
  });
  await labelSession(dir, { sessionId, host: 'h' }, new FakeProvider(), { now: '2026-06-20T09:00:00Z' });
}

describe('computeReport', () => {
  it('aggregates totals, tags, signals, and similar sessions', async () => {
    await withTempDirAsync(async (store) => {
      await seed(store, 's1');
      await seed(store, 's2');
      const report = computeReport(store, '2026-06-20T10:00:00Z');
      expect(report.sessions).toBe(2);
      expect(report.hosts.h).toBe(2);
      expect(report.totals.input_tokens).toBe(400);
      expect(report.topTags.find((t) => t.tag === 'Edit')?.count).toBe(2);
      expect(report.signalCounts['high-cost-turn']).toBe(2);
      // both sessions share the 'Edit' tag -> similar
      const sim = report.similar.find((s) => s.tag === 'Edit');
      expect(sim?.sessions.sort()).toEqual(['s1', 's2']);
      expect(report.byMonth['2026-06']?.sessions).toBe(2);
    });
  });
});

describe('renderDigest / renderSite', () => {
  it('produces markdown + html from a report', async () => {
    await withTempDirAsync(async (store) => {
      await seed(store, 's1');
      const report = computeReport(store, '2026-06-20T10:00:00Z');
      const md = renderDigest(report);
      expect(md).toContain('# Session digest');
      expect(md).toContain('Estimated cost');
      const html = renderSite(report);
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('code-sessions');
    });
  });
});

describe('cmdAnalytics', () => {
  it('writes report.json, digest.md, and index.html into the store', async () => {
    await withTempDirAsync(async (store) => {
      await seed(store, 's1');
      const res = await cmdAnalytics(makeConfig(store), { now: '2026-06-20T10:00:00Z' });
      expect(res.code).toBe(0);
      const dir = join(store, 'analytics');
      expect(existsSync(join(dir, 'report.json'))).toBe(true);
      expect(existsSync(join(dir, 'digest.md'))).toBe(true);
      expect(existsSync(join(dir, 'index.html'))).toBe(true);
      const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
      expect(report.sessions).toBe(1);
    });
  });
});
