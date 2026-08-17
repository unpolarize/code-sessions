import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listSessionDirs } from '../store/scan';
import { envelopeFile, turnFile } from '../store/paths';
import { isSessionId } from './sessionLink';

export interface LocatedSession {
  sessionId: string;
  host: string;
  month: string;
  dir: string;
  title: string;
  projectPath: string;
  agent: string;
  startedAt?: string;
  turnCount: number;
  labels: string[];
}

export interface SessionTurnView {
  turn_index: number;
  role: string;
  text: string;
  tools: string[];
  ts?: string;
}

export function findSession(storeDir: string, sessionId: string, hostHint?: string): LocatedSession | null {
  if (!isSessionId(sessionId)) return null;
  const dirs = listSessionDirs(storeDir);
  const matches = dirs.filter((d) => d.sessionId === sessionId);
  if (matches.length === 0) return null;
  const picked =
    (hostHint ? matches.find((m) => m.host === hostHint) : undefined) ?? matches[0]!;
  let title = sessionId;
  let projectPath = '';
  let agent = 'unknown';
  let startedAt: string | undefined;
  let turnCount = 0;
  let labels: string[] = [];
  try {
    const env = JSON.parse(readFileSync(envelopeFile(picked.dir), 'utf8')) as {
      title?: string;
      project_path?: string;
      agent?: string;
      started_at?: string;
      turn_count?: number;
      labels?: string[];
    };
    if (env.title) title = env.title;
    if (env.project_path) projectPath = env.project_path;
    if (env.agent) agent = env.agent;
    if (env.started_at) startedAt = env.started_at;
    if (typeof env.turn_count === 'number') turnCount = env.turn_count;
    if (Array.isArray(env.labels)) labels = env.labels.map(String);
  } catch {
    /* envelope optional */
  }
  return {
    sessionId,
    host: picked.host,
    month: picked.month,
    dir: picked.dir,
    title,
    projectPath,
    agent,
    startedAt,
    turnCount,
    labels,
  };
}

export function readTurns(dir: string, limit = 200): SessionTurnView[] {
  const out: SessionTurnView[] = [];
  for (let i = 0; i < limit; i++) {
    const p = turnFile(dir, i);
    if (!existsSync(p)) {
      // some stores start at 1 or skip; try a few more then stop after a gap
      if (i > 0 && out.length > 0 && !existsSync(turnFile(dir, i + 1))) break;
      continue;
    }
    try {
      const t = JSON.parse(readFileSync(p, 'utf8')) as {
        turn_index?: number;
        role?: string;
        text?: string;
        tool_calls?: Array<{ name?: string }>;
        ts?: string;
      };
      out.push({
        turn_index: typeof t.turn_index === 'number' ? t.turn_index : i,
        role: String(t.role || 'unknown'),
        text: String(t.text || ''),
        tools: Array.isArray(t.tool_calls)
          ? t.tool_calls.map((c) => String(c.name || '')).filter(Boolean)
          : [],
        ts: t.ts,
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function listRecent(storeDir: string, limit = 40): LocatedSession[] {
  const dirs = listSessionDirs(storeDir);
  const rows: LocatedSession[] = [];
  for (const d of dirs.slice(-Math.max(limit * 4, limit))) {
    const found = findSession(storeDir, d.sessionId, d.host);
    if (found) rows.push(found);
  }
  return rows
    .sort((a, b) => String(b.startedAt || b.month).localeCompare(String(a.startedAt || a.month)))
    .slice(0, limit);
}

export function sessionsRootHint(dir: string): boolean {
  return existsSync(join(dir, 'hosts'));
}
