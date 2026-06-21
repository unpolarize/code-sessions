import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SCHEMA_VERSIONS,
  type AgentKind,
  type ClaudeSessionMeta,
  type ToolCall,
  type Turn,
} from '@unpolarize/code-sessions-schema';
import type { ImportedSession } from './import';

/**
 * Code Build VSCode (CB) adapter. CB stores each chat at
 * ~/.codebuild/sessions/<uuid>.jsonl as a stream of:
 *   {type:"meta", meta:{id, backend, title, cwd}}
 *   {type:"user", text}
 *   {type:"update", update:{kind:"agent_message_chunk", content:{type:"text",text}}}
 *   {type:"update", update:{kind:"tool_call", toolCall:{title, rawInput}}}
 *   {type:"update", update:{kind:"usage"|"result", usage:{...}}}
 * Events carry no per-line timestamp; synthesized from file mtime + ordinal.
 *
 * Importing CB sessions into the CS store is how "CB context management uses CS":
 * every CB turn becomes discoverable in the shared sessions store + index, and a
 * CB switch/fork can be expressed as a CS forkSession on the persisted session.
 */

export function codebuildSessionsRoot(): string {
  return join(homedir(), '.codebuild', 'sessions');
}

export interface CodebuildSessionInfo {
  sessionId: string;
  path: string;
}

export function discoverCodebuildSessions(root = codebuildSessionsRoot()): CodebuildSessionInfo[] {
  if (!existsSync(root)) return [];
  let files: string[];
  try {
    files = readdirSync(root).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return files.map((f) => ({ sessionId: f.replace(/\.jsonl$/, ''), path: join(root, f) }));
}

function backendToAgent(backend: unknown): AgentKind {
  if (backend === 'claude') return 'claude-code';
  if (backend === 'grok') return 'grok';
  if (backend === 'codex') return 'codex';
  return 'unknown';
}

interface Pending {
  text: string;
  tools: ToolCall[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export function parseCodebuildSession(info: CodebuildSessionInfo, host: string): ImportedSession | null {
  let raw = '';
  try {
    raw = readFileSync(info.path, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const baseMs = statMtime(info.path);

  let agent: AgentKind = 'unknown';
  let sessionId = info.sessionId;
  let title: string | undefined;
  let cwd: string | undefined;

  const turns: Turn[] = [];
  let pending: Pending | null = null;
  let idx = 0;

  const flush = (): void => {
    if (!pending) return;
    const p = pending;
    pending = null;
    const turn = mkTurn(sessionId, host, agent, idx++, baseMs, 'assistant', p.text, p.tools);
    turn.usage = {
      input_tokens: p.input_tokens,
      output_tokens: p.output_tokens,
      cache_read_tokens: p.cache_read_tokens,
      cache_write_tokens: 0,
    };
    if (p.cost_usd > 0) turn.telemetry = { cost_usd: p.cost_usd };
    turns.push(turn);
  };
  const ensurePending = (): Pending => {
    if (!pending) pending = { text: '', tools: [], input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 };
    return pending;
  };

  for (const line of lines) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'meta' && ev.meta) {
      agent = backendToAgent(ev.meta.backend);
      if (typeof ev.meta.id === 'string') sessionId = ev.meta.id;
      if (typeof ev.meta.title === 'string') title = ev.meta.title;
      if (typeof ev.meta.cwd === 'string') cwd = ev.meta.cwd;
      continue;
    }
    if (ev.type === 'user' && typeof ev.text === 'string') {
      flush();
      turns.push(mkTurn(sessionId, host, agent, idx++, baseMs, 'user', ev.text, []));
      continue;
    }
    if (ev.type === 'update' && ev.update) {
      const u = ev.update;
      if (u.kind === 'agent_message_chunk') {
        const t = u.content?.text;
        if (typeof t === 'string') ensurePending().text += t;
      } else if (u.kind === 'tool_call' && u.toolCall) {
        const p = ensurePending();
        p.tools.push({ name: String(u.toolCall.title ?? u.toolCall.kind ?? 'tool'), input: u.toolCall.rawInput });
      } else if (u.kind === 'usage' && u.usage) {
        const p = ensurePending();
        p.input_tokens += Number(u.usage.inputTokens) || 0;
        p.output_tokens += Number(u.usage.outputTokens) || 0;
        p.cache_read_tokens += Number(u.usage.cacheReadTokens) || 0;
      } else if (u.kind === 'result' && u.usage) {
        const p = ensurePending();
        p.input_tokens += Number(u.usage.inputTokens) || 0;
        p.output_tokens += Number(u.usage.outputTokens) || 0;
        p.cost_usd += Number(u.usage.costUsd) || 0;
        flush();
      }
    }
  }
  flush();

  if (turns.length === 0) return null;
  const meta: ClaudeSessionMeta = {
    session_id: sessionId,
    started_at: turns[0]!.ts,
    ended_at: turns[turns.length - 1]!.ts,
  };
  if (cwd) meta.project_path = cwd;
  if (title) meta.title = title;
  // Stamp CB provenance so the store/CSV can tell a Code Build session apart
  // from a native claude/grok session even though its backend agent matches.
  return { host, sessionId, agent, turns, meta, format: 'codebuild-jsonl' };
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
  agent: AgentKind,
  index: number,
  baseMs: number,
  role: Turn['role'],
  text: string,
  tool_calls: ToolCall[],
): Turn {
  return {
    schema: SCHEMA_VERSIONS.turn,
    session_id: sessionId,
    host,
    agent,
    turn_index: index,
    ts: new Date(baseMs + index * 1000).toISOString(),
    role,
    text,
    tool_calls,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
  };
}
