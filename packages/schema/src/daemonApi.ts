/**
 * Sessions daemon JSON-RPC API (target.md phase 1).
 * Transport: JSON-RPC 2.0, one request per newline, over daemon.sock.
 * Additive within a major protocol number; `hello` is the version gate.
 */

export const DAEMON_PROTOCOL = 1;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export function isJsonRpcRequest(x: unknown): x is JsonRpcRequest {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return o.jsonrpc === '2.0' && typeof o.method === 'string';
}

export interface HelloResult {
  daemonVersion: string;
  protocol: number;
}

export interface SessionCreateParams {
  backend?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  mode?: string;
  kind?: string;
  title?: string;
  id?: string;
}

export interface SessionListFilter {
  cwd?: string;
  host?: string;
  backend?: string;
  agent?: string;
  hasContent?: boolean;
}

export interface SessionListParams {
  filter?: SessionListFilter;
  limit?: number;
  cursor?: string;
}

export interface SessionListItem {
  id: string;
  host: string;
  agent: string;
  cwd: string;
  title?: string;
  backend?: string;
  model?: string;
  hasContent: boolean;
  startedAt?: string;
  endedAt?: string;
  turnCount: number;
  eventSeq: number;
}

export interface SessionListResult {
  sessions: SessionListItem[];
  nextCursor?: string;
}

export interface SessionEvent {
  seq: number;
  ts: number;
  event: unknown;
}

/** `session.subscribe`. Omit `id` or pass `"all"` for every session. */
export interface SessionSubscribeParams {
  id?: string;
}

/** JSON-RPC notification `session.event` pushed on a subscribed connection. */
export interface SessionEventParams {
  id: string;
  seq: number;
  ts: number;
  event: unknown;
}

export interface MetricsResult {
  eventLoopLagMs: { p50: number; p99: number };
  queueDepth: number;
  indexLagMs?: number;
  lastSyncAt?: string;
  sessions: number;
  protocol: number;
}

export const RPC_PARSE = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL = -32603;
