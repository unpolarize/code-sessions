import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SCHEMA_VERSIONS,
  type ClaudeSessionMeta,
  type ToolCall,
  type Turn,
} from '@unpolarize/code-sessions-schema';
import { readEntries } from '../store/scan';
import type { ImportedSession } from './import';

/**
 * Codex CLI adapter. Codex stores rollouts at
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl — a header/meta line
 * plus event lines. The exact event schema has shifted across codex releases,
 * so this parser is intentionally defensive: it extracts user/assistant
 * messages + function (tool) calls from several known shapes and ignores the
 * rest. Validated against fixtures; confirm against your real rollouts after
 * `codex login`.
 */

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function codexSessionsRoot(): string {
  return join(homedir(), '.codex', 'sessions');
}

export interface CodexSessionInfo {
  sessionId: string;
  path: string;
}

export function discoverCodexSessions(root = codexSessionsRoot()): CodexSessionInfo[] {
  if (!existsSync(root)) return [];
  const out: CodexSessionInfo[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    for (const e of readEntries(dir)) {
      const name = String(e.name);
      const full = join(dir, name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && name.endsWith('.jsonl')) {
        const m = UUID_RE.exec(name);
        out.push({ sessionId: m ? m[1]! : name.replace(/\.jsonl$/, ''), path: full });
      }
    }
  };
  walk(root, 0);
  return out;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const o = b as any;
          if (typeof o.text === 'string') return o.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof (content as any).text === 'string') {
    return (content as any).text;
  }
  return '';
}

/** Normalize one codex event line into a partial turn, or null. */
function normalizeCodexLine(
  ev: any,
): { role: Turn['role']; text: string; tool_calls: ToolCall[] } | null {
  // payload wrapper (response_item / event_msg) or flat
  const p = ev?.payload && typeof ev.payload === 'object' ? ev.payload : ev;
  const ptype = p?.type;

  if (ptype === 'message' || (p?.role && p?.content !== undefined)) {
    const role: Turn['role'] = p.role === 'assistant' ? 'assistant' : p.role === 'tool' ? 'tool' : 'user';
    return { role, text: textFromContent(p.content), tool_calls: [] };
  }
  if (ptype === 'function_call' || ptype === 'local_shell_call' || ptype === 'tool_call') {
    const name = typeof p.name === 'string' ? p.name : ptype === 'local_shell_call' ? 'shell' : 'tool';
    let input: unknown = p.arguments ?? p.input ?? p.action;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        /* keep string */
      }
    }
    return { role: 'assistant', text: '', tool_calls: [{ name, input }] };
  }
  if (ptype === 'function_call_output' || ptype === 'tool_result') {
    return { role: 'tool', text: textFromContent(p.output ?? p.content), tool_calls: [] };
  }
  return null;
}

function lineTs(ev: any, fallback: string): string {
  const t = ev?.timestamp ?? ev?.ts;
  if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) return t;
  return fallback;
}

export function parseCodexSession(info: CodexSessionInfo, host: string): ImportedSession | null {
  const lines = readFileSync(info.path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  let model: string | undefined;
  let cwd: string | undefined;
  let sessionId = info.sessionId;
  let baseTs = '2020-01-01T00:00:00Z';

  const turns: Turn[] = [];
  let idx = 0;
  for (const line of lines) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const meta = ev?.payload?.type === 'session_meta' ? ev.payload : ev?.type === 'session_meta' ? ev : null;
    if (meta || ev?.id || ev?.cwd || ev?.model) {
      const src = meta ?? ev;
      if (typeof src.model === 'string') model = src.model;
      if (typeof src.cwd === 'string') cwd = src.cwd;
      if (typeof src.id === 'string') sessionId = UUID_RE.exec(src.id)?.[1] ?? sessionId;
      const t = src.timestamp ?? src.ts;
      if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) baseTs = t;
      if (meta) continue; // pure meta line, no turn
    }
    const norm = normalizeCodexLine(ev);
    if (!norm) continue;
    const ts = lineTs(ev, new Date(Date.parse(baseTs) + idx * 1000).toISOString());
    turns.push({
      schema: SCHEMA_VERSIONS.turn,
      session_id: sessionId,
      host,
      agent: 'codex',
      turn_index: idx++,
      ts,
      role: norm.role,
      text: norm.text,
      tool_calls: norm.tool_calls,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      scrubbed: false,
      raw_ref: null,
    });
  }

  if (turns.length === 0) return null;
  const meta: ClaudeSessionMeta = {
    session_id: sessionId,
    started_at: turns[0]!.ts,
    ended_at: turns[turns.length - 1]!.ts,
  };
  if (model) meta.model = model;
  if (cwd) meta.project_path = cwd;
  return { host, sessionId, agent: 'codex', turns, meta };
}
