import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  SCHEMA_VERSIONS,
  type AgentKind,
  type SessionEnvelope,
  type SessionCreateParams,
  type SessionEvent,
  type SessionListItem,
  type SessionListParams,
  type SessionListResult,
} from '@unpolarize/code-sessions-schema';
import type { CodeSessionsConfig } from './config';
import { envelopeFile, eventsFile, monthOf, sessionDir } from './store/paths';
import { listSessionDirs } from './store/scan';
import { readEnvelope, writeEnvelope } from './store/writer';

const BACKEND_AGENT: Record<string, AgentKind> = {
  claude: 'claude-code',
  grok: 'grok',
  codex: 'codex',
  codebuild: 'codebuild',
};

function agentForBackend(backend?: string): AgentKind {
  if (!backend) return 'codebuild';
  return BACKEND_AGENT[backend] ?? 'codebuild';
}

function cwdMatches(sessionCwd: string, filterCwd: string): boolean {
  const a = sessionCwd.replace(/\/+$/, '');
  const b = filterCwd.replace(/\/+$/, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function toItem(env: SessionEnvelope, seq: number): SessionListItem {
  const cwd = env.project_path || '';
  const hasContent = env.hasContent === true || env.turn_count > 0 || seq > 0;
  return {
    id: env.session_id,
    host: env.host,
    agent: env.agent,
    cwd,
    title: env.title,
    backend: env.backend,
    model: env.model,
    hasContent,
    startedAt: env.started_at,
    endedAt: env.ended_at,
    turnCount: env.turn_count,
    eventSeq: env.event_seq ?? seq,
  };
}

function lastSeqFromEvents(dir: string): number {
  const p = eventsFile(dir);
  if (!existsSync(p)) return 0;
  const raw = readFileSync(p, 'utf8');
  let seq = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as SessionEvent;
      if (typeof rec.seq === 'number' && rec.seq > seq) seq = rec.seq;
    } catch {
      /* skip */
    }
  }
  return seq;
}

export class SessionService {
  private readonly listeners = new Set<(id: string, rec: SessionEvent) => void>();

  constructor(private readonly cfg: CodeSessionsConfig) {}

  onEvent(fn: (id: string, rec: SessionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(id: string, rec: SessionEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(id, rec);
      } catch {
        /* subscriber errors must not fail append */
      }
    }
  }

  create(params: SessionCreateParams = {}): { id: string } {
    const id = params.id && params.id.length > 0 ? params.id : randomUUID();
    const now = new Date().toISOString();
    const month = monthOf(now);
    const dir = sessionDir(this.cfg.storeDir, this.cfg.host, month, id);
    mkdirSync(dir, { recursive: true });
    const backend = params.backend ?? 'codebuild';
    const agent = agentForBackend(backend);
    const env: SessionEnvelope = {
      schema: SCHEMA_VERSIONS.session,
      session_id: id,
      host: this.cfg.host,
      agent,
      project_path: params.cwd ?? '',
      turn_count: 0,
      tool_call_count: 0,
      totals: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      labels: [],
      planning_refs: [],
      native_ref: { format: 'codebuild-jsonl', uuid: id },
      hasContent: false,
      backend,
      event_seq: 0,
      started_at: now,
    };
    if (params.model) env.model = params.model;
    if (params.effort) env.effort = params.effort;
    if (params.mode) env.mode = params.mode;
    if (params.kind) env.kind = params.kind;
    if (params.title) env.title = params.title;
    writeEnvelope(dir, env);
    return { id };
  }

  locate(id: string): { dir: string; env: SessionEnvelope } | undefined {
    for (const ref of listSessionDirs(this.cfg.storeDir)) {
      if (ref.sessionId !== id) continue;
      const env = readEnvelope(ref.dir);
      if (env) return { dir: ref.dir, env };
    }
    return undefined;
  }

  get(id: string): SessionEnvelope | undefined {
    return this.locate(id)?.env;
  }

  patchMeta(id: string, patch: Partial<SessionEnvelope>): SessionEnvelope {
    const found = this.locate(id);
    if (!found) {
      throw Object.assign(new Error(`session not found: ${id}`), { code: -32001 });
    }
    const { env, dir } = found;
    const merged: SessionEnvelope = { ...env };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'session_id' || k === 'schema' || k === 'host') continue;
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
    writeEnvelope(dir, merged);
    return merged;
  }

  append(id: string, event: unknown, ts = Date.now()): SessionEvent {
    const found = this.locate(id);
    if (!found) {
      throw Object.assign(new Error(`session not found: ${id}`), { code: -32001 });
    }
    const seq = (found.env.event_seq ?? lastSeqFromEvents(found.dir)) + 1;
    const rec: SessionEvent = { seq, ts, event };
    const p = eventsFile(found.dir);
    appendFileSync(p, `${JSON.stringify(rec)}\n`);
    const patch: Partial<SessionEnvelope> = { event_seq: seq, hasContent: true };
    writeEnvelope(found.dir, { ...found.env, ...patch, event_seq: seq, hasContent: true });
    this.emit(id, rec);
    return rec;
  }

  replay(id: string, fromSeq = 0): { events: SessionEvent[]; nextSeq: number } {
    const found = this.locate(id);
    if (!found) {
      throw Object.assign(new Error(`session not found: ${id}`), { code: -32001 });
    }
    const p = eventsFile(found.dir);
    const events: SessionEvent[] = [];
    let max = found.env.event_seq ?? 0;
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as SessionEvent;
          if (typeof rec.seq === 'number' && rec.seq > max) max = rec.seq;
          if (typeof rec.seq === 'number' && rec.seq >= fromSeq) events.push(rec);
        } catch {
          /* skip */
        }
      }
    }
    return { events, nextSeq: max + 1 };
  }

  list(params: SessionListParams = {}): SessionListResult {
    const filter = params.filter ?? {};
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const items: SessionListItem[] = [];
    for (const ref of listSessionDirs(this.cfg.storeDir)) {
      const env = readEnvelope(ref.dir);
      if (!env) continue;
      if (filter.host && env.host !== filter.host) continue;
      if (filter.agent && env.agent !== filter.agent) continue;
      if (filter.backend && env.backend !== filter.backend) continue;
      const cwd = env.project_path || '';
      if (filter.cwd && !cwdMatches(cwd, filter.cwd)) continue;
      const seq = env.event_seq ?? lastSeqFromEvents(ref.dir);
      const item = toItem(env, seq);
      if (filter.hasContent === true && !item.hasContent) continue;
      if (filter.hasContent === false && item.hasContent) continue;
      items.push(item);
    }
    items.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    const start = params.cursor ? items.findIndex((s) => s.id === params.cursor) + 1 : 0;
    const slice = items.slice(Math.max(0, start), Math.max(0, start) + limit);
    const last = slice[slice.length - 1];
    const more = start + slice.length < items.length;
    return { sessions: slice, nextCursor: more && last ? last.id : undefined };
  }
}

export function envelopePathFor(storeDir: string, host: string, id: string, startedAt?: string): string {
  return envelopeFile(sessionDir(storeDir, host, monthOf(startedAt), id));
}
