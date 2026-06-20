import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  SCHEMA_VERSIONS,
  safeParseSession,
  type SessionEnvelope,
  type Turn,
} from '@unpolarize/code-sessions-schema';
import type { CodeSessionsConfig } from './config';
import { computeEnvelope, readTurns, writeTurnFile } from './store/writer';
import { envelopeFile, monthOf, sessionDir } from './store/paths';
import { listSessionDirs } from './store/scan';

export interface ForkResult {
  newSessionId: string;
  sessionDir: string;
  turns: number;
  forkedFrom: { session_id: string; turn_index: number };
}

function locateSession(storeDir: string, sessionId: string): { dir: string } | undefined {
  const ref = listSessionDirs(storeDir).find((r) => r.sessionId === sessionId);
  return ref ? { dir: ref.dir } : undefined;
}

function loadEnvelope(dir: string): SessionEnvelope | undefined {
  const p = envelopeFile(dir);
  if (!existsSync(p)) return undefined;
  const parsed = safeParseSession(JSON.parse(readFileSync(p, 'utf8')));
  return parsed.success ? parsed.data : undefined;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Fork a session at a turn — "git for sessions". Copies turns [0..atTurn] of the
 * source into a NEW session keyed on this host, stamped with `forked_from`. The
 * new session can be resumed/continued in any agent from that branch point; all
 * turns stay discoverable via the index.
 */
export function forkSession(
  cfg: CodeSessionsConfig,
  opts: { sessionId: string; atTurn: number; newSessionId?: string; agent?: SessionEnvelope['agent'] },
): ForkResult {
  const located = locateSession(cfg.storeDir, opts.sessionId);
  if (!located) throw new Error(`session not found in store: ${opts.sessionId}`);
  const srcEnv = loadEnvelope(located.dir);
  const allTurns = readTurns(located.dir);
  const prefix = allTurns.filter((t) => t.turn_index <= opts.atTurn);
  if (prefix.length === 0) throw new Error(`no turns at or before index ${opts.atTurn}`);

  const newId = opts.newSessionId ?? randomUUID();
  const agent = opts.agent ?? srcEnv?.agent ?? 'claude-code';
  const month = monthOf(srcEnv?.started_at ?? prefix[0]?.ts);
  const dir = sessionDir(cfg.storeDir, cfg.host, month, newId);

  const newTurns: Turn[] = prefix.map((t) => ({
    ...t,
    session_id: newId,
    host: cfg.host,
    agent,
  }));
  for (const t of newTurns) writeTurnFile(dir, t);

  const env = computeEnvelope(
    newTurns,
    {
      ...(srcEnv?.model ? { model: srcEnv.model } : {}),
      ...(srcEnv?.project_path ? { project_path: srcEnv.project_path } : {}),
      ...(srcEnv?.title ? { title: `fork: ${srcEnv.title}` } : {}),
    },
    { session_id: newId, host: cfg.host, agent, native_uuid: newId },
  );
  env.forked_from = { session_id: opts.sessionId, turn_index: opts.atTurn };
  env.native_ref.format = 'fork';
  writeJsonAtomic(envelopeFile(dir), env);

  return {
    newSessionId: newId,
    sessionDir: dir,
    turns: newTurns.length,
    forkedFrom: env.forked_from,
  };
}
