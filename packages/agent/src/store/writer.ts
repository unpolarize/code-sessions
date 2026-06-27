import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  SCHEMA_VERSIONS,
  type AgentKind,
  type SessionEnvelope,
  type Turn,
} from '@unpolarize/code-sessions-schema';
import type { ClaudeSessionMeta } from '@unpolarize/code-sessions-schema';
import { envelopeFile, rawBlobFile, sessionDir, turnFile } from './paths';

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, filePath); // atomic on the same filesystem
}

export interface WriteTurnResult {
  path: string;
  written: boolean;
}

/** Write an immutable per-turn file. Never overwrites an existing turn. */
export function writeTurnFile(dir: string, turn: Turn): WriteTurnResult {
  const path = turnFile(dir, turn.turn_index);
  if (existsSync(path)) return { path, written: false };
  ensureDir(path);
  writeFileSync(path, `${JSON.stringify(turn, null, 2)}\n`);
  return { path, written: true };
}

/** Write a content-addressed blob (idempotent). */
export function writeBlobFile(dir: string, sha: string, content: string): string {
  const path = rawBlobFile(dir, sha);
  if (!existsSync(path)) {
    ensureDir(path);
    writeFileSync(path, content);
  }
  return path;
}

export function readTurns(dir: string): Turn[] {
  const turnsDir = `${dir}/turns`;
  if (!existsSync(turnsDir)) return [];
  return readdirSync(turnsDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .sort()
    .map((f) => JSON.parse(readFileSync(`${turnsDir}/${f}`, 'utf8')) as Turn);
}

export interface EnvelopeIdentity {
  session_id: string;
  host: string;
  agent: AgentKind;
  native_uuid: string;
}

/** Pure: derive a session envelope from its turns + extracted metadata. */
export function computeEnvelope(
  turns: Turn[],
  meta: ClaudeSessionMeta,
  identity: EnvelopeIdentity,
  existing?: Partial<SessionEnvelope>,
): SessionEnvelope {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let toolCalls = 0;
  for (const t of turns) {
    inputTokens += t.usage.input_tokens;
    outputTokens += t.usage.output_tokens;
    toolCalls += t.tool_calls.length;
    cost += t.telemetry?.cost_usd ?? 0;
  }
  const first = turns[0];
  const last = turns[turns.length - 1];

  const env: SessionEnvelope = {
    schema: SCHEMA_VERSIONS.session,
    session_id: identity.session_id,
    host: identity.host,
    agent: identity.agent,
    project_path: meta.project_path ?? existing?.project_path ?? '',
    turn_count: turns.length,
    tool_call_count: toolCalls,
    totals: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: Math.round(cost * 1e6) / 1e6,
    },
    labels: existing?.labels ?? [],
    planning_refs: existing?.planning_refs ?? [],
    native_ref: { format: 'claude-jsonl', uuid: identity.native_uuid },
  };
  const branch = meta.git_branch ?? existing?.git_branch;
  if (branch) env.git_branch = branch;
  const model = meta.model ?? existing?.model;
  if (model) env.model = model;
  const startedAt = meta.started_at ?? first?.ts ?? existing?.started_at;
  if (startedAt) env.started_at = startedAt;
  const endedAt = meta.ended_at ?? last?.ts ?? existing?.ended_at;
  if (endedAt) env.ended_at = endedAt;
  const title = meta.title ?? existing?.title;
  if (title) env.title = title;
  return env;
}

/** Read turns from disk, derive the envelope (preserving prior labels/title), and write session.json. */
export function rebuildEnvelope(
  storeDir: string,
  host: string,
  month: string,
  sessionId: string,
  meta: ClaudeSessionMeta,
  identity: EnvelopeIdentity,
): SessionEnvelope {
  const dir = sessionDir(storeDir, host, month, sessionId);
  const turns = readTurns(dir);
  const envPath = envelopeFile(dir);
  let existing: Partial<SessionEnvelope> | undefined;
  if (existsSync(envPath)) {
    try {
      existing = JSON.parse(readFileSync(envPath, 'utf8')) as SessionEnvelope;
    } catch {
      /* ignore */
    }
  }
  const env = computeEnvelope(turns, meta, identity, existing);
  writeJsonAtomic(envPath, env);
  return env;
}
