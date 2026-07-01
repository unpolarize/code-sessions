import { connect } from 'node:net';

/** Hook event delivered over the daemon's unix socket (newline-delimited JSON). */
export interface HookEvent {
  event: string;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  /** Pre/PostToolUse: the tool name (Claude `tool_name`, Grok `toolName`). */
  tool_name?: string;
  /** Pre/PostToolUse: the tool input/args (may be gated out of telemetry). */
  tool_input?: unknown;
  /** Pre/PostToolUse: correlation id for the tool call. */
  tool_use_id?: string;
}

export interface HookAck {
  ok: boolean;
  newTurns?: number;
  flushed?: boolean;
  error?: string;
}

const LIFECYCLE_END = new Set(['Stop', 'SubagentStop', 'SessionEnd']);

export function isSessionEndEvent(event: string): boolean {
  return LIFECYCLE_END.has(event);
}

/** Normalize a raw payload (from a socket line or a Claude hook stdin doc) into a HookEvent. */
export function parseHookEvent(raw: unknown): HookEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const event = (r.event ?? r.hook_event_name ?? r.hookEventName) as string | undefined;
  const session_id = (r.session_id ?? r.sessionId) as string | undefined;
  if (!event || !session_id) return null;
  const out: HookEvent = { event, session_id };
  const tp = (r.transcript_path ?? r.transcriptPath) as string | undefined;
  if (typeof tp === 'string') out.transcript_path = tp;
  if (typeof r.cwd === 'string') out.cwd = r.cwd;
  // Pre/PostToolUse tool fields — Claude snake_case, Grok camelCase.
  const toolName = (r.tool_name ?? r.toolName) as string | undefined;
  if (typeof toolName === 'string') out.tool_name = toolName;
  const toolInput = r.tool_input ?? r.toolInput;
  if (toolInput !== undefined) out.tool_input = toolInput;
  const toolUseId = (r.tool_use_id ?? r.toolUseId) as string | undefined;
  if (typeof toolUseId === 'string') out.tool_use_id = toolUseId;
  return out;
}

/** Connect to the daemon socket, send one event, resolve with its ack. */
export function sendEvent(
  socketPath: string,
  event: HookEvent,
  timeoutMs = 4000,
): Promise<HookAck> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    let buf = '';
    let settled = false;
    const done = (ack: HookAck) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ack);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify(event)}\n`));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          done(JSON.parse(buf.slice(0, nl)) as HookAck);
        } catch {
          done({ ok: false, error: 'bad ack' });
        }
      }
    });
    sock.on('timeout', () => done({ ok: false, error: 'timeout' }));
    sock.on('error', (e) => done({ ok: false, error: e.message }));
  });
}
