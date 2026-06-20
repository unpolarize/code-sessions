import { existsSync, readFileSync, statSync } from 'node:fs';
import { safeParseInsights, safeParseSession } from '@unpolarize/code-sessions-schema';
import type { CodeSessionsConfig } from '../config';
import { envelopeFile, insightsFile } from '../store/paths';
import { listSessionDirs } from '../store/scan';
import { readTurns } from '../store/writer';
import { SessionIndex } from './db';

export interface IndexSyncStats {
  total: number;
  indexed: number;
  unchanged: number;
  removed: number;
}

/**
 * Project the git store into the SQLite index, incrementally (mtime/size
 * invalidation per session.json). Rebuildable any time; the git files stay
 * authoritative.
 */
export function syncIndex(
  cfg: CodeSessionsConfig,
  opts: { index?: SessionIndex; now?: number } = {},
): IndexSyncStats {
  const index = opts.index ?? new SessionIndex(cfg.indexPath);
  const ownsIndex = !opts.index;
  const now = opts.now ?? Date.now();
  try {
    const refs = listSessionDirs(cfg.storeDir);
    const known = index.knownSources();
    const seen = new Set<string>();
    let indexed = 0;
    let unchanged = 0;

    for (const ref of refs) {
      const envPath = envelopeFile(ref.dir);
      if (!existsSync(envPath)) continue;
      const st = statSync(envPath);
      const mtime_ms = Math.floor(st.mtimeMs);
      const size_bytes = st.size;
      seen.add(ref.sessionId);

      const cached = known.get(ref.sessionId);
      if (cached && cached.mtime_ms === mtime_ms && cached.size_bytes === size_bytes) {
        unchanged++;
        continue;
      }

      const parsed = safeParseSession(JSON.parse(readFileSync(envPath, 'utf8')));
      if (!parsed.success) continue;
      const env = parsed.data;

      let topic: string | undefined;
      const insPath = insightsFile(ref.dir);
      let insights = undefined;
      if (existsSync(insPath)) {
        const pi = safeParseInsights(JSON.parse(readFileSync(insPath, 'utf8')));
        if (pi.success) {
          insights = pi.data;
          topic = pi.data.topic;
        }
      }

      index.upsertSession(env, {
        source_path: envPath,
        mtime_ms,
        size_bytes,
        indexed_at: now,
        ...(topic ? { topic } : {}),
      });
      index.replaceTurns(env.session_id, readTurns(ref.dir));
      if (insights) index.upsertInsight(insights);
      indexed++;
    }

    const removed = [...known.keys()].filter((id) => !seen.has(id));
    index.deleteSessions(removed);

    return { total: refs.length, indexed, unchanged, removed: removed.length };
  } finally {
    if (ownsIndex) index.close();
  }
}
