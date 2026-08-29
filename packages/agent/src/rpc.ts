import { connect } from 'node:net';
import type { Socket } from 'node:net';
import {
  DAEMON_PROTOCOL,
  isJsonRpcRequest,
  RPC_INTERNAL,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type HelloResult,
  type MetricsResult,
  type SessionCreateParams,
  type SessionListParams,
  type SessionListResult,
  type SessionEvent,
  type SessionEnvelope,
} from '@unpolarize/code-sessions-schema';
import type { CodeSessionsConfig } from './config';
import { SessionService } from './sessionService';

export { DAEMON_PROTOCOL };

export interface RpcContext {
  cfg: CodeSessionsConfig;
  sessions: SessionService;
  lag: () => { p50: number; p99: number };
  queueDepth: () => number;
  daemonVersion: string;
  /** Register this connection for `session.event` notifications. */
  subscribe?: (filter: { id?: string }) => void;
}

export async function handleRpc(ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  try {
    switch (req.method) {
      case 'hello':
        return reply({
          daemonVersion: ctx.daemonVersion,
          protocol: DAEMON_PROTOCOL,
        } satisfies HelloResult);
      case 'session.create': {
        const params = (req.params ?? {}) as SessionCreateParams;
        return reply(ctx.sessions.create(params));
      }
      case 'session.get': {
        const params = req.params as { id?: string } | undefined;
        if (!params?.id) return fail(RPC_INVALID_PARAMS, 'id required');
        const env = ctx.sessions.get(params.id);
        if (!env) return fail(-32001, `session not found: ${params.id}`);
        return reply(env);
      }
      case 'session.patchMeta': {
        const params = req.params as { id?: string; patch?: Partial<SessionEnvelope> } | undefined;
        if (!params?.id || !params.patch) return fail(RPC_INVALID_PARAMS, 'id and patch required');
        return reply(ctx.sessions.patchMeta(params.id, params.patch));
      }
      case 'session.append': {
        const params = req.params as { id?: string; event?: unknown; ts?: number } | undefined;
        if (!params?.id || params.event === undefined) return fail(RPC_INVALID_PARAMS, 'id and event required');
        return reply(ctx.sessions.append(params.id, params.event, params.ts));
      }
      case 'session.replay': {
        const params = req.params as { id?: string; fromSeq?: number } | undefined;
        if (!params?.id) return fail(RPC_INVALID_PARAMS, 'id required');
        return reply(ctx.sessions.replay(params.id, params.fromSeq ?? 0));
      }
      case 'session.list': {
        const params = (req.params ?? {}) as SessionListParams;
        return reply(ctx.sessions.list(params) satisfies SessionListResult);
      }
      case 'session.subscribe': {
        const params = (req.params ?? {}) as { id?: string };
        if (!ctx.subscribe) {
          if (req.id === undefined || req.id === null) return null;
          return fail(RPC_INTERNAL, 'subscribe not available on this connection');
        }
        const raw = typeof params.id === 'string' ? params.id : undefined;
        const id = raw && raw !== 'all' ? raw : undefined;
        ctx.subscribe({ id });
        if (req.id === undefined || req.id === null) return null;
        return reply({ ok: true, filter: id ?? 'all' });
      }
      case 'index.query': {
        const params = (req.params ?? {}) as SessionListParams;
        return reply(ctx.sessions.list(params));
      }
      case 'store.sync':
        return reply({ ok: true });
      case 'metrics': {
        const lag = ctx.lag();
        const result: MetricsResult = {
          eventLoopLagMs: lag,
          queueDepth: ctx.queueDepth(),
          protocol: DAEMON_PROTOCOL,
          sessions: ctx.sessions.list({ limit: 500 }).sessions.length,
        };
        return reply(result);
      }
      default:
        if (req.id === undefined || req.id === null) return null;
        return fail(RPC_METHOD_NOT_FOUND, `method not found: ${req.method}`);
    }
  } catch (e) {
    const err = e as Error & { code?: number };
    return fail(typeof err.code === 'number' ? err.code : RPC_INTERNAL, err.message || String(e));
  }
}

export function parseLine(line: string): JsonRpcRequest | 'hook' | 'invalid' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return 'invalid';
  }
  if (isJsonRpcRequest(parsed)) return parsed;
  return 'hook';
}

/** One-shot JSON-RPC call. Closes the socket after the matching response. */
export function rpcCall(
  socketPath: string,
  method: string,
  params?: unknown,
  timeoutMs = 4000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    let settled = false;
    const id = 1;
    const done = (err: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      sock.write(`${JSON.stringify(req)}\n`);
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as JsonRpcResponse;
        if (msg.error) done(new Error(msg.error.message));
        else done(null, msg.result);
      } catch (e) {
        done(e as Error);
      }
    });
    sock.on('timeout', () => done(new Error('rpc timeout')));
    sock.on('error', (e) => done(e));
  });
}

export type { Socket };
