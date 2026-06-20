import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import type { Insights, SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';

// Load node:sqlite at runtime via createRequire so the bundler never rewrites
// the `node:` specifier (esbuild doesn't yet know `node:sqlite` is a builtin and
// would strip the prefix to a bare `sqlite` package). Types come from the
// type-only import above.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncT;
};

/**
 * Internal SQLite index for the CS library — a queryable projection of the git
 * `sessions` store. Built on node:sqlite (Node's built-in, zero native deps).
 * This is a CACHE, rebuildable from the store at any time; the git files remain
 * the source of truth. Mirrors the shape CS-vscode's cache uses so a consumer
 * can share the model.
 */

const SCHEMA_VERSION = 2;

export interface SessionIndexRow {
  session_id: string;
  host: string;
  agent: string;
  project_path: string;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  turn_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  title: string | null;
  labels: string[];
  topic: string | null;
  intent: string | null;
  projects: string[];
  source_path: string;
}

function toMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isNaN(v) ? null : v;
}

export class SessionIndex {
  readonly db: DatabaseSyncT;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    const cur = row?.user_version ?? 0;
    if (cur < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session (
          session_id TEXT PRIMARY KEY,
          host TEXT NOT NULL,
          agent TEXT NOT NULL,
          project_path TEXT NOT NULL DEFAULT '',
          model TEXT,
          started_at INTEGER,
          ended_at INTEGER,
          turn_count INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          title TEXT,
          labels_json TEXT NOT NULL DEFAULT '[]',
          topic TEXT,
          intent TEXT,
          projects_json TEXT NOT NULL DEFAULT '[]',
          source_path TEXT NOT NULL,
          mtime_ms INTEGER NOT NULL DEFAULT 0,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          indexed_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_session_started ON session(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_session_agent ON session(agent);
        CREATE TABLE IF NOT EXISTS turn (
          turn_uuid TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
          turn_index INTEGER NOT NULL,
          ts INTEGER,
          role TEXT NOT NULL,
          text TEXT NOT NULL DEFAULT '',
          tool_names_csv TEXT NOT NULL DEFAULT '',
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_turn_session ON turn(session_id, turn_index);
        CREATE TABLE IF NOT EXISTS insight (
          session_id TEXT PRIMARY KEY REFERENCES session(session_id) ON DELETE CASCADE,
          topic TEXT,
          intent TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          projects_json TEXT NOT NULL DEFAULT '[]',
          signals_json TEXT NOT NULL DEFAULT '[]',
          provider TEXT,
          generated_at TEXT
        );
      `);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (cur < 2) {
      // additive v1 -> v2: intent + projects columns
      this.db.exec(`
        ALTER TABLE session ADD COLUMN intent TEXT;
        ALTER TABLE session ADD COLUMN projects_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE insight ADD COLUMN intent TEXT;
        ALTER TABLE insight ADD COLUMN projects_json TEXT NOT NULL DEFAULT '[]';
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    }
  }

  /** session_id -> {mtime_ms, size_bytes} for incremental sync invalidation. */
  knownSources(): Map<string, { mtime_ms: number; size_bytes: number }> {
    const rows = this.db.prepare('SELECT session_id, mtime_ms, size_bytes FROM session').all() as Array<{
      session_id: string;
      mtime_ms: number;
      size_bytes: number;
    }>;
    const m = new Map<string, { mtime_ms: number; size_bytes: number }>();
    for (const r of rows) m.set(r.session_id, { mtime_ms: r.mtime_ms, size_bytes: r.size_bytes });
    return m;
  }

  upsertSession(
    env: SessionEnvelope,
    src: {
      source_path: string;
      mtime_ms: number;
      size_bytes: number;
      indexed_at: number;
      topic?: string;
      intent?: string;
      projects?: string[];
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO session (session_id, host, agent, project_path, model, started_at, ended_at,
           turn_count, tool_call_count, input_tokens, output_tokens, cost_usd, title, labels_json,
           topic, intent, projects_json, source_path, mtime_ms, size_bytes, indexed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           host=excluded.host, agent=excluded.agent, project_path=excluded.project_path,
           model=excluded.model, started_at=excluded.started_at, ended_at=excluded.ended_at,
           turn_count=excluded.turn_count, tool_call_count=excluded.tool_call_count,
           input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
           cost_usd=excluded.cost_usd, title=excluded.title, labels_json=excluded.labels_json,
           topic=excluded.topic, intent=excluded.intent, projects_json=excluded.projects_json,
           source_path=excluded.source_path, mtime_ms=excluded.mtime_ms,
           size_bytes=excluded.size_bytes, indexed_at=excluded.indexed_at`,
      )
      .run(
        env.session_id,
        env.host,
        env.agent,
        env.project_path,
        env.model ?? null,
        toMs(env.started_at),
        toMs(env.ended_at),
        env.turn_count,
        env.tool_call_count,
        env.totals.input_tokens,
        env.totals.output_tokens,
        env.totals.cost_usd,
        env.title ?? null,
        JSON.stringify(env.labels ?? []),
        src.topic ?? null,
        src.intent ?? null,
        JSON.stringify(src.projects ?? []),
        src.source_path,
        src.mtime_ms,
        src.size_bytes,
        src.indexed_at,
      );
  }

  replaceTurns(sessionId: string, turns: Turn[]): void {
    this.db.prepare('DELETE FROM turn WHERE session_id = ?').run(sessionId);
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO turn (turn_uuid, session_id, turn_index, ts, role, text,
         tool_names_csv, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const t of turns) {
      stmt.run(
        `${sessionId}#${t.turn_index}`,
        sessionId,
        t.turn_index,
        toMs(t.ts),
        t.role,
        t.text.slice(0, 8192),
        t.tool_calls.map((c) => c.name).join(','),
        t.usage.input_tokens,
        t.usage.output_tokens,
        t.telemetry?.cost_usd ?? 0,
      );
    }
  }

  upsertInsight(ins: Insights): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO insight (session_id, topic, intent, tags_json, projects_json, signals_json, provider, generated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        ins.session_id,
        ins.topic ?? null,
        ins.intent ?? null,
        JSON.stringify(ins.tags ?? []),
        JSON.stringify(ins.projects ?? []),
        JSON.stringify(ins.signals ?? []),
        ins.provider,
        ins.generated_at,
      );
  }

  deleteSessions(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('DELETE FROM session WHERE session_id = ?');
    for (const id of ids) stmt.run(id);
  }

  private rowToIndex(r: any): SessionIndexRow {
    return {
      session_id: r.session_id,
      host: r.host,
      agent: r.agent,
      project_path: r.project_path,
      model: r.model ?? null,
      started_at: r.started_at ?? null,
      ended_at: r.ended_at ?? null,
      turn_count: r.turn_count,
      tool_call_count: r.tool_call_count,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cost_usd: r.cost_usd,
      title: r.title ?? null,
      labels: safeJson(r.labels_json),
      topic: r.topic ?? null,
      intent: r.intent ?? null,
      projects: safeJson(r.projects_json),
      source_path: r.source_path,
    };
  }

  listRecent(limit = 50, agent?: string): SessionIndexRow[] {
    const rows = agent
      ? this.db
          .prepare('SELECT * FROM session WHERE agent = ? ORDER BY started_at DESC LIMIT ?')
          .all(agent, limit)
      : this.db.prepare('SELECT * FROM session ORDER BY started_at DESC LIMIT ?').all(limit);
    return (rows as any[]).map((r) => this.rowToIndex(r));
  }

  getSession(id: string): SessionIndexRow | undefined {
    const r = this.db.prepare('SELECT * FROM session WHERE session_id = ?').get(id);
    return r ? this.rowToIndex(r) : undefined;
  }

  /** Full-text-ish search over turn text + session titles. */
  searchTurns(query: string, limit = 50): SessionIndexRow[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.* FROM session s
         LEFT JOIN turn t ON t.session_id = s.session_id
         WHERE t.text LIKE ? OR s.title LIKE ?
         ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(like, like, limit);
    return (rows as any[]).map((r) => this.rowToIndex(r));
  }

  stats(): { sessions: number; turns: number; cost_usd: number; byAgent: Record<string, number> } {
    const s = this.db.prepare('SELECT COUNT(*) c, COALESCE(SUM(cost_usd),0) cost FROM session').get() as {
      c: number;
      cost: number;
    };
    const t = this.db.prepare('SELECT COUNT(*) c FROM turn').get() as { c: number };
    const agents = this.db.prepare('SELECT agent, COUNT(*) c FROM session GROUP BY agent').all() as Array<{
      agent: string;
      c: number;
    }>;
    const byAgent: Record<string, number> = {};
    for (const a of agents) byAgent[a.agent] = a.c;
    return { sessions: s.c, turns: t.c, cost_usd: Math.round(s.cost * 1e6) / 1e6, byAgent };
  }

  close(): void {
    this.db.close();
  }
}

function safeJson(s: unknown): string[] {
  if (typeof s !== 'string') return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
