import { existsSync } from 'node:fs';
import { parseHookEvent, sendEvent, type HookAck } from '../ipc';

/**
 * Hook shim: forward a Claude Code hook payload (JSON on stdin) to the daemon
 * socket. Must NEVER block or fail the agent — a missing/unreachable daemon is
 * a silent no-op.
 */
export async function handleHookInput(socketPath: string, rawInput: string): Promise<HookAck> {
  if (!existsSync(socketPath)) return { ok: false, error: 'daemon not running' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return { ok: false, error: 'invalid hook json' };
  }
  const evt = parseHookEvent(parsed);
  if (!evt) return { ok: false, error: 'unrecognized hook payload' };
  return sendEvent(socketPath, evt);
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
