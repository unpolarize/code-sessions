import {
  SCHEMA_VERSIONS,
  type AgentKind,
  type Role,
  type ToolCall,
  type Turn,
  type Usage,
} from './schemas';

/**
 * Adapter: Claude Code JSONL events -> canonical turn records.
 *
 * Claude writes one JSON object per line. The conversational lines are `user`
 * and `assistant`; everything else (`ai-title`, `system`, `permission-mode`,
 * `queue-operation`, `attachment`, `last-prompt`, `summary`) is metadata and
 * does not become a turn.
 */

// Native Claude events are loosely typed; we narrow defensively.
type Raw = Record<string, any>;

export interface NormalizedEvent {
  ts: string;
  role: Role;
  text: string;
  tool_calls: ToolCall[];
  usage: Usage;
  raw: unknown;
}

export interface BuildTurnContext {
  session_id: string;
  host: string;
  agent: AgentKind;
  turn_index: number;
}

const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

function mapUsage(u: Raw | undefined): Usage {
  if (!u || typeof u !== 'object') return { ...ZERO_USAGE };
  const num = (v: unknown): number => (typeof v === 'number' && v >= 0 ? Math.floor(v) : 0);
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_tokens: num(u.cache_read_input_tokens ?? u.cache_read_tokens),
    cache_write_tokens: num(u.cache_creation_input_tokens ?? u.cache_write_tokens),
  };
}

function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object') {
      const b = block as Raw;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'tool_result') parts.push(toolResultText(b.content));
    }
  }
  return parts.join('\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as Raw).text === 'string'
          ? (c as Raw).text
          : typeof c === 'string'
            ? c
            : JSON.stringify(c),
      )
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function extractToolCalls(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return [];
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Raw).type === 'tool_use') {
      const b = block as Raw;
      const call: ToolCall = { name: typeof b.name === 'string' ? b.name : 'unknown' };
      if (b.input !== undefined) call.input = b.input;
      if (typeof b.id === 'string') call.id = b.id;
      calls.push(call);
    }
  }
  return calls;
}

function hasToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((b) => b && typeof b === 'object' && (b as Raw).type === 'tool_result')
  );
}

/** Map a single native Claude line into a normalized event, or null if it is metadata. */
export function normalizeClaudeEvent(raw: unknown, fallbackTs = ''): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const ev = raw as Raw;
  const ts: string = typeof ev.timestamp === 'string' ? ev.timestamp : fallbackTs;
  const message: Raw | undefined =
    ev.message && typeof ev.message === 'object' ? ev.message : undefined;

  if (ev.type === 'assistant' && message) {
    return {
      ts,
      role: 'assistant',
      text: blocksToText(message.content),
      tool_calls: extractToolCalls(message.content),
      usage: mapUsage(message.usage),
      raw,
    };
  }

  if (ev.type === 'user' && message) {
    const isTool = hasToolResult(message.content);
    return {
      ts,
      role: isTool ? 'tool' : 'user',
      text: blocksToText(message.content),
      tool_calls: [],
      usage: { ...ZERO_USAGE },
      raw,
    };
  }

  return null;
}

/** Assemble a complete, schema-valid Turn from a normalized event + identity context. */
export function buildTurn(ev: NormalizedEvent, ctx: BuildTurnContext): Turn {
  return {
    schema: SCHEMA_VERSIONS.turn,
    session_id: ctx.session_id,
    host: ctx.host,
    agent: ctx.agent,
    turn_index: ctx.turn_index,
    ts: ev.ts,
    role: ev.role,
    text: ev.text,
    tool_calls: ev.tool_calls,
    usage: ev.usage,
    scrubbed: false,
    raw_ref: null,
    raw: ev.raw,
  };
}

export interface ClaudeSessionMeta {
  session_id?: string;
  model?: string;
  project_path?: string;
  git_branch?: string;
  title?: string;
  started_at?: string;
  ended_at?: string;
}

/** Pull session-envelope metadata out of a batch of native Claude lines. */
export function extractClaudeSessionMeta(rawLines: unknown[]): ClaudeSessionMeta {
  const meta: ClaudeSessionMeta = {};
  for (const raw of rawLines) {
    if (!raw || typeof raw !== 'object') continue;
    const ev = raw as Raw;
    if (typeof ev.sessionId === 'string' && !meta.session_id) meta.session_id = ev.sessionId;
    if (typeof ev.cwd === 'string') meta.project_path = ev.cwd;
    if (typeof ev.gitBranch === 'string') meta.git_branch = ev.gitBranch;
    if (ev.message && typeof ev.message.model === 'string') meta.model = ev.message.model;
    if (ev.type === 'ai-title') {
      const t = ev.title ?? ev.message ?? ev.content;
      if (typeof t === 'string') meta.title = t;
    }
    if (typeof ev.timestamp === 'string') {
      if (!meta.started_at) meta.started_at = ev.timestamp;
      meta.ended_at = ev.timestamp;
    }
  }
  return meta;
}

/** Convenience: normalize a full batch of lines with sequential turn indices (for tests/backfill). */
export function normalizeClaudeLines(
  rawLines: unknown[],
  ctx: { session_id: string; host: string; agent: AgentKind; startIndex?: number },
): { turns: Turn[]; meta: ClaudeSessionMeta } {
  let idx = ctx.startIndex ?? 0;
  const turns: Turn[] = [];
  for (const raw of rawLines) {
    const norm = normalizeClaudeEvent(raw);
    if (!norm) continue;
    turns.push(
      buildTurn(norm, {
        session_id: ctx.session_id,
        host: ctx.host,
        agent: ctx.agent,
        turn_index: idx++,
      }),
    );
  }
  return { turns, meta: extractClaudeSessionMeta(rawLines) };
}
