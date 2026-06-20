import {
  buildTurn,
  extractClaudeSessionMeta,
  normalizeClaudeEvent,
  type ClaudeSessionMeta,
  type SessionEnvelope,
  type Turn,
} from '@unpolarize/code-sessions-schema';
import type { CodeSessionsConfig } from './config';
import { applyHygiene } from './hygiene';
import { estimateCostUsd } from './pricing';
import type { StateStore } from './state';
import { sessionDir } from './store/paths';
import { rebuildEnvelope, writeBlobFile, writeTurnFile } from './store/writer';
import { readNewLines } from './tail';
import { monthOf } from './store/paths';

export interface CaptureResult {
  sessionId: string;
  sessionDir: string;
  month: string;
  newTurns: number;
  writtenPaths: string[];
  redactions: number;
  envelope?: SessionEnvelope;
}

/**
 * The capture engine: given a session id + its native transcript path, consume
 * newly-appended JSONL, normalize + apply hygiene + cost, write immutable
 * per-turn files, and rebuild the derived envelope. Restart-safe via StateStore
 * (byte offset + next turn index persisted).
 */
export class CaptureEngine {
  constructor(
    private readonly config: CodeSessionsConfig,
    private readonly state: StateStore,
  ) {}

  captureSession(sessionId: string, transcriptPath: string): CaptureResult {
    const st = this.state.ensure(sessionId, transcriptPath);
    const tail = readNewLines(transcriptPath, st.offset);

    const meta = extractClaudeSessionMeta(tail.records);
    const month = st.month ?? monthOf(meta.started_at ?? firstTs(tail.records));
    const dir = sessionDir(this.config.storeDir, this.config.host, month, sessionId);

    const writtenPaths: string[] = [];
    let nextIndex = st.nextTurnIndex;
    let redactions = 0;

    for (const rec of tail.records) {
      const norm = normalizeClaudeEvent(rec);
      if (!norm) continue;
      let turn: Turn = buildTurn(norm, {
        session_id: sessionId,
        host: this.config.host,
        agent: this.config.agent,
        turn_index: nextIndex,
      });
      // attach cost telemetry for billable (assistant) turns
      const cost = estimateCostUsd(turn.usage, meta.model);
      if (cost > 0) turn = { ...turn, telemetry: { cost_usd: cost } };

      const hy = applyHygiene(turn, this.config.hygiene);
      redactions += hy.redactions.reduce((a, m) => a + m.count, 0);
      if (hy.blob) writtenPaths.push(writeBlobFile(dir, hy.blob.sha, hy.blob.content));

      const res = writeTurnFile(dir, hy.turn);
      if (res.written) {
        writtenPaths.push(res.path);
        nextIndex++;
      }
    }

    // advance state regardless (offset moves past consumed bytes even if all metadata)
    this.state.update(sessionId, {
      transcriptPath,
      offset: tail.newOffset,
      nextTurnIndex: nextIndex,
      month,
      startedAt: st.startedAt ?? meta.started_at,
      lastTs: meta.ended_at ?? st.lastTs,
    });

    const newTurns = nextIndex - st.nextTurnIndex;
    const result: CaptureResult = {
      sessionId,
      sessionDir: dir,
      month,
      newTurns,
      writtenPaths,
      redactions,
    };
    if (newTurns > 0 || writtenPaths.length > 0) {
      result.envelope = rebuildEnvelope(
        this.config.storeDir,
        this.config.host,
        month,
        sessionId,
        meta,
        {
          session_id: sessionId,
          host: this.config.host,
          agent: this.config.agent,
          native_uuid: sessionId,
        },
      );
    }
    return result;
  }
}

function firstTs(records: unknown[]): string | undefined {
  for (const r of records) {
    if (r && typeof r === 'object' && typeof (r as { timestamp?: unknown }).timestamp === 'string') {
      return (r as { timestamp: string }).timestamp;
    }
  }
  return undefined;
}
