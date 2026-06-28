import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Daemon bookkeeping — NOT the store. Tracks, per native session, how far we
 * have consumed its JSONL and the next canonical turn index. Rebuildable by
 * re-scanning if lost.
 */

export interface SessionState {
  /** native transcript path being tailed */
  transcriptPath: string;
  /** bytes of the transcript already consumed */
  offset: number;
  /** next canonical turn_index to assign */
  nextTurnIndex: number;
  /** YYYY-MM shard the session was filed under (from its first turn) */
  month?: string;
  startedAt?: string;
  lastTs?: string;
  endedAt?: string;
  /** fingerprint (mtime:size) of an imported source file, for poll-based watch dedup */
  sourceFingerprint?: string;
}

interface StateFile {
  version: 1;
  sessions: Record<string, SessionState>;
}

export class StateStore {
  private data: StateFile;

  constructor(private readonly path: string) {
    this.data = this.read();
  }

  private read(): StateFile {
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StateFile;
        if (parsed && parsed.version === 1 && parsed.sessions) return parsed;
      } catch {
        // fall through to fresh state
      }
    }
    return { version: 1, sessions: {} };
  }

  /** Atomic write: tmp file + rename. */
  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  get(sessionId: string): SessionState | undefined {
    return this.data.sessions[sessionId];
  }

  /** Get existing state or initialize a fresh one for this transcript. */
  ensure(sessionId: string, transcriptPath: string): SessionState {
    let s = this.data.sessions[sessionId];
    if (!s) {
      s = { transcriptPath, offset: 0, nextTurnIndex: 0 };
      this.data.sessions[sessionId] = s;
      this.flush();
    } else if (transcriptPath && s.transcriptPath !== transcriptPath) {
      s.transcriptPath = transcriptPath;
      this.flush();
    }
    return s;
  }

  update(sessionId: string, patch: Partial<SessionState>): SessionState {
    const s = this.data.sessions[sessionId] ?? {
      transcriptPath: '',
      offset: 0,
      nextTurnIndex: 0,
    };
    const next = { ...s, ...patch };
    this.data.sessions[sessionId] = next;
    this.flush();
    return next;
  }

  all(): Record<string, SessionState> {
    return this.data.sessions;
  }
}
