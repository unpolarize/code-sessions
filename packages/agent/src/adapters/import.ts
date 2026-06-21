import type {
  AgentKind,
  ClaudeSessionMeta,
  SessionEnvelope,
  Turn,
} from '@unpolarize/code-sessions-schema';
import type { CodeSessionsConfig } from '../config';
import { applyHygiene } from '../hygiene';
import { monthOf, sessionDir } from '../store/paths';
import { computeEnvelope, writeBlobFile, writeTurnFile } from '../store/writer';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { envelopeFile } from '../store/paths';

const NATIVE_FORMAT: Record<string, string> = {
  'claude-code': 'claude-jsonl',
  grok: 'grok-jsonl',
  codex: 'codex-rollout',
  unknown: 'unknown',
};

export interface ImportedSession {
  host: string;
  sessionId: string;
  agent: AgentKind;
  turns: Turn[];
  meta: ClaudeSessionMeta;
  /** Override native_ref.format to preserve provenance when the agent kind
   * doesn't capture it (e.g. a Code Build session whose backend is claude). */
  format?: string;
}

export interface ImportResult {
  sessionId: string;
  sessionDir: string;
  turns: number;
  envelope: SessionEnvelope;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Persist an imported (non-claude) session into the store: hygiene each turn,
 * write immutable per-turn files, derive + write the envelope. Reuses the same
 * writer the live claude capture path uses, so all agents land in one store.
 */
export function writeImportedSession(cfg: CodeSessionsConfig, s: ImportedSession): ImportResult {
  const month = monthOf(s.meta.started_at ?? s.turns[0]?.ts);
  const dir = sessionDir(cfg.storeDir, s.host, month, s.sessionId);

  for (const turn of s.turns) {
    const hy = applyHygiene(turn, cfg.hygiene);
    if (hy.blob) writeBlobFile(dir, hy.blob.sha, hy.blob.content);
    writeTurnFile(dir, hy.turn);
  }

  const env = computeEnvelope(s.turns, s.meta, {
    session_id: s.sessionId,
    host: s.host,
    agent: s.agent,
    native_uuid: s.sessionId,
  });
  env.native_ref.format = s.format ?? NATIVE_FORMAT[s.agent] ?? 'unknown';
  // preserve labels if a prior envelope exists
  const envPath = envelopeFile(dir);
  if (existsSync(envPath)) {
    try {
      const prev = JSON.parse(readFileSync(envPath, 'utf8')) as SessionEnvelope;
      if (prev.labels?.length) env.labels = prev.labels;
    } catch {
      /* ignore */
    }
  }
  writeJsonAtomic(envPath, env);

  return { sessionId: s.sessionId, sessionDir: dir, turns: s.turns.length, envelope: env };
}
