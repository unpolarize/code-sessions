import { describe, expect, it } from 'vitest';
import type { Insights, SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';
import { SessionIndex } from './db';

function env(id: string, agent: SessionEnvelope['agent'], over: Partial<SessionEnvelope> = {}): SessionEnvelope {
  return {
    schema: 'session-store/session@1',
    session_id: id,
    host: 'h',
    agent,
    project_path: '/p',
    model: 'claude-opus-4-8',
    started_at: '2026-06-20T08:00:00Z',
    ended_at: '2026-06-20T08:05:00Z',
    turn_count: 2,
    tool_call_count: 1,
    totals: { input_tokens: 100, output_tokens: 20, cost_usd: 0.5 },
    title: `session ${id}`,
    labels: ['debugging'],
    native_ref: { format: 'claude-jsonl', uuid: id },
    ...over,
  };
}

function turn(sid: string, i: number, role: Turn['role'], text: string): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: sid,
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: `2026-06-20T08:0${i}:00Z`,
    role,
    text,
    tool_calls: role === 'assistant' ? [{ name: 'Edit' }] : [],
    usage: { input_tokens: 50, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
  };
}

const src = { source_path: '/s/x.json', mtime_ms: 1000, size_bytes: 200, indexed_at: 1 };

describe('SessionIndex', () => {
  it('upserts sessions/turns/insights and queries them', () => {
    const idx = new SessionIndex(':memory:');
    try {
      idx.upsertSession(env('s1', 'claude-code'), { ...src, topic: 'fixing a bug' });
      idx.replaceTurns('s1', [turn('s1', 0, 'user', 'fix the parser bug'), turn('s1', 1, 'assistant', 'done')]);
      idx.upsertInsight({
        schema: 'session-store/insights@1',
        session_id: 's1',
        host: 'h',
        generated_at: 't',
        provider: 'fake',
        topic: 'fixing a bug',
        tags: ['Edit'],
        signals: [{ kind: 'high-cost-turn', severity: 'warn' }],
      } as Insights);

      const got = idx.getSession('s1')!;
      expect(got.agent).toBe('claude-code');
      expect(got.input_tokens).toBe(100);
      expect(got.labels).toEqual(['debugging']);
      expect(got.topic).toBe('fixing a bug');

      expect(idx.listRecent(10)).toHaveLength(1);
      expect(idx.searchTurns('parser')).toHaveLength(1);
      expect(idx.searchTurns('nonexistent')).toHaveLength(0);

      const s = idx.stats();
      expect(s.sessions).toBe(1);
      expect(s.turns).toBe(2);
      expect(s.byAgent['claude-code']).toBe(1);
    } finally {
      idx.close();
    }
  });

  it('is idempotent on re-upsert and supports incremental invalidation keys', () => {
    const idx = new SessionIndex(':memory:');
    try {
      idx.upsertSession(env('s1', 'grok'), src);
      idx.upsertSession(env('s1', 'grok', { title: 'updated' }), { ...src, mtime_ms: 2000 });
      expect(idx.listRecent(10)).toHaveLength(1);
      expect(idx.getSession('s1')!.title).toBe('updated');
      const known = idx.knownSources();
      expect(known.get('s1')!.mtime_ms).toBe(2000);
    } finally {
      idx.close();
    }
  });

  it('filters by agent and deletes sessions (cascade turns)', () => {
    const idx = new SessionIndex(':memory:');
    try {
      idx.upsertSession(env('c1', 'claude-code'), src);
      idx.upsertSession(env('g1', 'grok'), { ...src, source_path: '/s/g.json' });
      idx.replaceTurns('c1', [turn('c1', 0, 'user', 'hi')]);
      expect(idx.listRecent(10, 'grok')).toHaveLength(1);
      idx.deleteSessions(['c1']);
      expect(idx.getSession('c1')).toBeUndefined();
      expect(idx.stats().turns).toBe(0); // cascade removed c1's turn
    } finally {
      idx.close();
    }
  });
});
