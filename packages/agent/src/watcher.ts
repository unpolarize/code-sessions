import { statSync } from 'node:fs';
import type { CodeSessionsConfig } from './config';
import type { StateStore } from './state';
import { discoverCodexSessions, parseCodexSession } from './adapters/codex';
import { discoverGrokSessions, parseGrokSession } from './adapters/grok';
import { writeImportedSession, type ImportedSession } from './adapters/import';

/**
 * Poll-based capture for agents that write session files locally but can't push
 * hook events to the daemon — currently Codex (~/.codex/sessions) and Grok
 * (~/.grok/sessions). On an interval the watcher discovers their sessions, imports
 * the new or changed ones (mtime+size fingerprint dedup, tracked in the daemon
 * state file), and reports counts so the daemon can commit/push the result. This
 * brings codex/grok to capture parity with Claude's live hook path.
 */

export interface SourceWatcherDeps {
  /** override the codex sessions root (defaults to ~/.codex/sessions) */
  codexRoot?: string;
  /** override the grok sessions root (defaults to ~/.grok/sessions) */
  grokRoot?: string;
  /** fingerprint a source file (mtime:size); undefined when missing. Injectable for tests. */
  fingerprint?: (path: string) => string | undefined;
}

export interface AgentScanResult {
  imported: number;
  skipped: number;
  turns: number;
}

export interface ScanResult {
  imported: number;
  skipped: number;
  turns: number;
  perAgent: { codex: AgentScanResult; grok: AgentScanResult };
}

/** One discovered source session, normalized so codex/grok share the scan loop. */
interface SourceItem {
  /** dedup key namespace, e.g. `codex:<id>` */
  key: string;
  /** file whose mtime+size fingerprints the session */
  fingerprintPath: string;
  parse: () => ImportedSession | null;
}

function defaultFingerprint(path: string): string | undefined {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return undefined;
  }
}

export class SourceWatcher {
  private readonly fingerprint: (path: string) => string | undefined;
  private readonly codexRoot: string | undefined;
  private readonly grokRoot: string | undefined;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly cfg: CodeSessionsConfig,
    private readonly state: StateStore,
    deps: SourceWatcherDeps = {},
  ) {
    this.fingerprint = deps.fingerprint ?? defaultFingerprint;
    this.codexRoot = deps.codexRoot;
    this.grokRoot = deps.grokRoot;
  }

  /** Whether any source is enabled (so the daemon can skip starting an idle watcher). */
  get enabled(): boolean {
    return this.cfg.capture.watch.codex || this.cfg.capture.watch.grok;
  }

  /** Discover + import all new/changed sessions for the enabled sources. */
  scanOnce(): ScanResult {
    const codex = this.cfg.capture.watch.codex
      ? this.scanAgent(this.codexItems())
      : { imported: 0, skipped: 0, turns: 0 };
    const grok = this.cfg.capture.watch.grok
      ? this.scanAgent(this.grokItems())
      : { imported: 0, skipped: 0, turns: 0 };
    return {
      imported: codex.imported + grok.imported,
      skipped: codex.skipped + grok.skipped,
      turns: codex.turns + grok.turns,
      perAgent: { codex, grok },
    };
  }

  /** Start periodic scanning. Runs once immediately, then every `intervalMs`. */
  start(onImported: (r: ScanResult) => void): void {
    if (this.timer) return;
    const tick = (): void => {
      const r = this.scanOnce();
      if (r.imported > 0) onImported(r);
    };
    tick();
    this.timer = setInterval(tick, this.cfg.capture.watch.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private codexItems(): SourceItem[] {
    const found = this.codexRoot ? discoverCodexSessions(this.codexRoot) : discoverCodexSessions();
    return found.map((info) => ({
      key: `codex:${info.sessionId}`,
      fingerprintPath: info.path,
      parse: () => parseCodexSession(info, this.cfg.host),
    }));
  }

  private grokItems(): SourceItem[] {
    const found = this.grokRoot ? discoverGrokSessions(this.grokRoot) : discoverGrokSessions();
    return found.map((info) => ({
      key: `grok:${info.sessionId}`,
      fingerprintPath: info.chatPath,
      parse: () => parseGrokSession(info, this.cfg.host),
    }));
  }

  private scanAgent(items: SourceItem[]): AgentScanResult {
    let imported = 0;
    let skipped = 0;
    let turns = 0;
    for (const item of items) {
      const fp = this.fingerprint(item.fingerprintPath);
      const prev = this.state.get(item.key)?.sourceFingerprint;
      if (fp && fp === prev) {
        skipped++;
        continue;
      }
      const session = item.parse();
      if (!session) {
        skipped++;
        continue;
      }
      turns += writeImportedSession(this.cfg, session).turns;
      imported++;
      this.state.update(item.key, { transcriptPath: item.fingerprintPath, ...(fp ? { sourceFingerprint: fp } : {}) });
    }
    return { imported, skipped, turns };
  }
}
