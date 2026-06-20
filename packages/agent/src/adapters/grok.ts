import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SCHEMA_VERSIONS,
  type ClaudeSessionMeta,
  type ToolCall,
  type Turn,
} from '@unpolarize/code-sessions-schema';
import type { ImportedSession } from './import';

/**
 * Grok Build CLI adapter. Grok stores each session as a directory under
 * ~/.grok/sessions/<url-encoded-cwd>/<uuid>/ with chat_history.jsonl (event
 * stream) + summary.json (metadata). Events carry no per-event timestamp, so
 * we synthesize them from summary.created_at + line ordinal (ordering only).
 */

export function grokSessionsRoot(): string {
  return join(homedir(), '.grok', 'sessions');
}

export interface GrokSessionInfo {
  sessionId: string;
  chatPath: string;
  summaryPath: string;
  cwd: string;
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export function discoverGrokSessions(root = grokSessionsRoot()): GrokSessionInfo[] {
  if (!existsSync(root)) return [];
  const out: GrokSessionInfo[] = [];
  for (const enc of safeDirs(root)) {
    let cwd = enc;
    try {
      cwd = decodeURIComponent(enc);
    } catch {
      /* keep raw */
    }
    for (const uuid of safeDirs(join(root, enc))) {
      const dir = join(root, enc, uuid);
      const chatPath = join(dir, 'chat_history.jsonl');
      const summaryPath = join(dir, 'summary.json');
      if (existsSync(chatPath)) out.push({ sessionId: uuid, chatPath, summaryPath, cwd });
    }
  }
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b && typeof b === 'object' && (b as any).type === 'text' ? String((b as any).text ?? '') : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function parseArgs(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

interface GrokSummary {
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
  generated_title?: string;
  session_summary?: string;
  current_model_id?: string;
  session_kind?: string;
  info?: { cwd?: string };
}

/** Parse one grok session into a canonical ImportedSession (or null to skip). */
export function parseGrokSession(info: GrokSessionInfo, host: string): ImportedSession | null {
  let summary: GrokSummary = {};
  if (existsSync(info.summaryPath)) {
    try {
      summary = JSON.parse(readFileSync(info.summaryPath, 'utf8')) as GrokSummary;
    } catch {
      /* defaults */
    }
  }
  if (summary.session_kind === 'claude_import') return null; // claude indexer is authoritative

  const baseMs = Date.parse(summary.created_at ?? '') || statMtime(info.chatPath);
  const lines = readFileSync(info.chatPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);

  const turns: Turn[] = [];
  let idx = 0;
  let model = summary.current_model_id;
  for (const line of lines) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = new Date(baseMs + idx * 1000).toISOString();
    if (ev.type === 'user') {
      turns.push(mkTurn(info.sessionId, host, idx++, ts, 'user', extractText(ev.content), []));
    } else if (ev.type === 'assistant') {
      if (typeof ev.model_id === 'string') model = ev.model_id;
      const tools: ToolCall[] = Array.isArray(ev.tool_calls)
        ? ev.tool_calls
            .filter((t: any) => t && typeof t.name === 'string')
            .map((t: any) => ({ name: t.name, input: parseArgs(t.arguments), ...(t.id ? { id: t.id } : {}) }))
        : [];
      turns.push(mkTurn(info.sessionId, host, idx++, ts, 'assistant', extractText(ev.content), tools));
    } else if (ev.type === 'tool_result') {
      turns.push(mkTurn(info.sessionId, host, idx++, ts, 'tool', extractText(ev.content), []));
    }
    // system / reasoning: skipped
  }

  if (turns.length === 0) return null;

  const startedAt = new Date(baseMs).toISOString();
  const endedAt = turns[turns.length - 1]!.ts;
  const meta: ClaudeSessionMeta = {
    session_id: info.sessionId,
    project_path: summary.info?.cwd ?? info.cwd,
    started_at: startedAt,
    ended_at: endedAt,
  };
  if (model) meta.model = model;
  const title = summary.generated_title?.trim() || summary.session_summary?.trim();
  if (title) meta.title = title;

  return { host, sessionId: info.sessionId, agent: 'grok', turns, meta };
}

function statMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return Date.parse('2020-01-01T00:00:00Z');
  }
}

function mkTurn(
  sessionId: string,
  host: string,
  index: number,
  ts: string,
  role: Turn['role'],
  text: string,
  tool_calls: ToolCall[],
): Turn {
  return {
    schema: SCHEMA_VERSIONS.turn,
    session_id: sessionId,
    host,
    agent: 'grok',
    turn_index: index,
    ts,
    role,
    text,
    tool_calls,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
  };
}
