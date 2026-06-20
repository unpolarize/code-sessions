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

interface NormalizedCodex {
  role: Turn['role'];
  text: string;
  tool_calls: ToolCall[];
}

/**
 * Normalize one codex event line. Codex (0.14x) emits the conversation as
 * `event_msg/{user_message,agent_message}` (payload.message is a string) and
 * tool calls as `response_item/function_call`. `response_item/message` carries
 * developer/permission scaffolding + reasoning, which we skip to avoid noise.
 */
function normalizeCodexLine(ev: any): NormalizedCodex | null {
  const p = ev?.payload && typeof ev.payload === 'object' ? ev.payload : ev;
  const ptype = p?.type;

  // primary conversation channel
  if (ev?.type === 'event_msg') {
    if (ptype === 'user_message' && typeof p.message === 'string') {
      return { role: 'user', text: p.message, tool_calls: [] };
    }
    if (ptype === 'agent_message' && typeof p.message === 'string') {
      return { role: 'assistant', text: p.message, tool_calls: [] };
    }
    return null; // task_started/complete/token_count/etc handled elsewhere
  }

  // tool calls live on response_item
  if (ev?.type === 'response_item') {
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
    // message / reasoning: scaffolding — skip
    return null;
  }
  return null;
}

interface CodexUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

function readTokenCount(ev: any): CodexUsage | null {
  if (ev?.type !== 'event_msg' || ev?.payload?.type !== 'token_count') return null;
  const u = ev.payload.info?.total_token_usage ?? ev.payload.info;
  if (!u || typeof u !== 'object') return null;
  return {
    input_tokens: Number(u.input_tokens) || 0,
    output_tokens: Number(u.output_tokens) || 0,
    cache_read_tokens: Number(u.cached_input_tokens ?? u.cache_read_tokens) || 0,
  };
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
  let latestUsage: CodexUsage | null = null;
  let lastAssistantIdx = -1;

  const turns: Turn[] = [];
  let idx = 0;
  for (const line of lines) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }

    // session_meta: metadata lives under payload (id, cwd, model, timestamp)
    if (ev?.type === 'session_meta') {
      const src = ev.payload && typeof ev.payload === 'object' ? ev.payload : ev;
      if (typeof src.model === 'string') model = src.model;
      if (typeof src.cwd === 'string') cwd = src.cwd;
      if (typeof src.id === 'string') sessionId = UUID_RE.exec(src.id)?.[1] ?? sessionId;
      const t = src.timestamp ?? ev.timestamp;
      if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) baseTs = t;
      continue;
    }
    if (ev?.type === 'turn_context' && typeof ev.payload?.cwd === 'string' && !cwd) {
      cwd = ev.payload.cwd;
    }

    const usage = readTokenCount(ev);
    if (usage) {
      latestUsage = usage; // cumulative; latest wins
      continue;
    }

    const norm = normalizeCodexLine(ev);
    if (!norm) continue;
    const ts = lineTs(ev, new Date(Date.parse(baseTs) + idx * 1000).toISOString());
    if (norm.role === 'assistant') lastAssistantIdx = turns.length;
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

  // Codex reports cumulative usage via token_count; attribute it to the final
  // assistant turn so the session envelope totals are non-zero.
  if (latestUsage && lastAssistantIdx >= 0) {
    turns[lastAssistantIdx]!.usage = {
      input_tokens: latestUsage.input_tokens,
      output_tokens: latestUsage.output_tokens,
      cache_read_tokens: latestUsage.cache_read_tokens,
      cache_write_tokens: 0,
    };
  }
  const meta: ClaudeSessionMeta = {
    session_id: sessionId,
    started_at: turns[0]!.ts,
    ended_at: turns[turns.length - 1]!.ts,
  };
  if (model) meta.model = model;
  if (cwd) meta.project_path = cwd;
  return { host, sessionId, agent: 'codex', turns, meta };
}
