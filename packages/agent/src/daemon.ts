import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { CaptureEngine } from './capture';
import type { CodeSessionsConfig } from './config';
import { isSessionEndEvent, parseHookEvent, type HookAck, type HookEvent } from './ipc';
import { StateStore } from './state';
import { GitStore } from './store/git';
import { readEntries } from './store/scan';
import { SourceWatcher, type ScanResult } from './watcher';
import { OtelReceiver } from './telemetry/receiver';

export type SessionEndHook = (sessionId: string, sessionDir: string) => void | Promise<void>;

export interface DaemonDeps {
  capture?: CaptureEngine;
  state?: StateStore;
  git?: GitStore;
  /** invoked on Stop/SubagentStop — the insights labeler hooks in here */
  onSessionEnd?: SessionEndHook;
  /** invoked on EVERY hook arrival (fire-and-forget) — real-time OTel log emission */
  onHookEvent?: (evt: HookEvent) => void | Promise<void>;
  /** poll-based capture for hookless agents (codex/grok); auto-created from config when omitted */
  watcher?: SourceWatcher;
  /** OTLP-trigger receiver (agent telemetry → capture); auto-created from config when omitted */
  receiver?: OtelReceiver;
}

export interface DaemonStatus {
  running: boolean;
  socketPath: string;
  storeDir: string;
  events: number;
  turns: number;
  commits: number;
  sessions: string[];
}

/** Find a Claude transcript file by session id under the projects dir (bounded scan). */
export function findTranscript(projectsDir: string, sessionId: string, maxDepth = 3): string | undefined {
  const target = `${sessionId}.jsonl`;
  const walk = (dir: string, depth: number): string | undefined => {
    if (depth > maxDepth || !existsSync(dir)) return undefined;
    const entries = readEntries(dir);
    for (const e of entries) {
      if (e.isFile() && String(e.name) === target) return join(dir, String(e.name));
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const found = walk(join(dir, String(e.name)), depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(projectsDir, 0);
}

/**
 * The headless capture daemon. Listens on a unix socket for hook events,
 * captures appended turns immediately, and batches git commits (flush on
 * session-end, on a turn threshold, or after an interval).
 */
export class Daemon {
  private server?: Server;
  private readonly capture: CaptureEngine;
  private readonly state: StateStore;
  private readonly git?: GitStore;
  private readonly onSessionEnd?: SessionEndHook;
  private readonly onHookEvent?: (evt: HookEvent) => void | Promise<void>;
  private watcher?: SourceWatcher;
  private receiver?: OtelReceiver;
  private readonly triggerTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private dirty = false;
  private pendingTurns = 0;
  private commitTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private readonly stats = { events: 0, turns: 0, commits: 0 };
  private readonly sessions = new Set<string>();

  constructor(
    private readonly cfg: CodeSessionsConfig,
    deps: DaemonDeps = {},
  ) {
    this.state = deps.state ?? new StateStore(cfg.statePath);
    this.capture = deps.capture ?? new CaptureEngine(cfg, this.state);
    if (cfg.git.autoCommit) {
      this.git =
        deps.git ??
        new GitStore(cfg.storeDir, {
          ...(cfg.git.remote ? { remote: cfg.git.remote } : {}),
          autoPush: cfg.git.autoPush,
        });
    }
    if (deps.onSessionEnd) this.onSessionEnd = deps.onSessionEnd;
    if (deps.onHookEvent) this.onHookEvent = deps.onHookEvent;
    if (deps.watcher) this.watcher = deps.watcher;
    if (deps.receiver) this.receiver = deps.receiver;
  }

  async start(): Promise<void> {
    mkdirSync(this.cfg.storeDir, { recursive: true });
    mkdirSync(this.cfg.runtimeDir, { recursive: true });
    this.git?.init();
    if (existsSync(this.cfg.socketPath)) rmSync(this.cfg.socketPath);
    await new Promise<void>((resolve, reject) => {
      const server = createServer((sock) => this.onConnection(sock));
      server.on('error', reject);
      server.listen(this.cfg.socketPath, () => {
        this.running = true;
        resolve();
      });
      this.server = server;
    });

    // Poll-based capture for hookless agents (codex/grok). Auto-create from config
    // unless one was injected. Runs an immediate scan, then on its own interval.
    if (!this.watcher) {
      const w = new SourceWatcher(this.cfg, this.state);
      if (w.enabled) this.watcher = w;
    }
    this.watcher?.start((r) => this.onWatcherImported(r));

    // OTLP-trigger receiver: an agent's own telemetry export drives capture.
    // Auto-create from config unless injected; resilient — a port clash logs and
    // leaves the daemon running on hooks/watch alone.
    if (!this.receiver && this.cfg.capture.otelTrigger.enabled) {
      this.receiver = new OtelReceiver(this.cfg.capture.otelTrigger, {
        onTrigger: (sessionId) => this.handleTrigger(sessionId),
      });
    }
    if (this.receiver) {
      try {
        await this.receiver.start();
      } catch {
        this.receiver = undefined; // port unavailable — degrade gracefully
      }
    }
  }

  /** A watcher scan imported sessions into the store — mark dirty and schedule a commit. */
  private onWatcherImported(r: ScanResult): void {
    this.dirty = true;
    this.pendingTurns += r.turns;
    this.stats.turns += r.turns;
    this.scheduleFlush();
  }

  /**
   * An agent's OTLP export named a session — capture it from the transcript (Claude)
   * or via the source watcher (codex/grok), then debounce a labels+export pass so a
   * burst of metric exports yields one GenAI-semconv emission per quiet period.
   */
  async handleTrigger(sessionId: string): Promise<void> {
    const transcript = findTranscript(this.cfg.claudeProjectsDir, sessionId);
    if (transcript) {
      const res = this.capture.captureSession(sessionId, transcript);
      this.sessions.add(sessionId);
      if (res.newTurns > 0 || res.writtenPaths.length > 0) {
        this.dirty = true;
        this.pendingTurns += res.newTurns;
        this.stats.turns += res.newTurns;
      }
      this.debounceSessionEnd(sessionId, res.sessionDir);
    } else if (this.watcher) {
      this.onWatcherImported(this.watcher.scanOnce());
    }
    this.scheduleFlush();
  }

  /** Coalesce trigger bursts: run onSessionEnd (labels + export) once after a quiet gap. */
  private debounceSessionEnd(sessionId: string, sessionDir: string): void {
    if (!this.onSessionEnd) return;
    const prev = this.triggerTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(async () => {
      this.triggerTimers.delete(sessionId);
      try {
        await this.onSessionEnd!(sessionId, sessionDir);
        this.dirty = true;
        this.flush(`otel-trigger ${sessionId}`);
      } catch {
        /* labeler/exporter already resilient */
      }
    }, 1500);
    timer.unref?.();
    this.triggerTimers.set(sessionId, timer);
  }

  private onConnection(sock: Socket): void {
    let buf = '';
    sock.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ack: HookAck;
        try {
          const evt = parseHookEvent(JSON.parse(line));
          ack = evt ? await this.handleEvent(evt) : { ok: false, error: 'invalid event' };
        } catch {
          ack = { ok: false, error: 'parse error' };
        }
        if (!sock.destroyed) sock.write(`${JSON.stringify(ack)}\n`);
      }
    });
    sock.on('error', () => {
      /* client hangup — ignore */
    });
  }

  /** Process a single hook event: capture, then decide whether to flush a commit. */
  async handleEvent(evt: HookEvent): Promise<HookAck> {
    this.stats.events++;
    // Real-time OTel log emission, fire-and-forget BEFORE the (slower) file capture,
    // so the signal lands even for tool-use events that carry no new transcript turns.
    if (this.onHookEvent) void this.onHookEvent(evt);
    const transcript =
      evt.transcript_path && existsSync(evt.transcript_path)
        ? evt.transcript_path
        : findTranscript(this.cfg.claudeProjectsDir, evt.session_id);
    if (!transcript) return { ok: false, error: 'transcript not found' };

    const res = this.capture.captureSession(evt.session_id, transcript);
    this.sessions.add(evt.session_id);
    if (res.newTurns > 0 || res.writtenPaths.length > 0) {
      this.dirty = true;
      this.pendingTurns += res.newTurns;
      this.stats.turns += res.newTurns;
    }

    const end = isSessionEndEvent(evt.event);
    let flushed = false;
    if (end && this.onSessionEnd) {
      await this.onSessionEnd(evt.session_id, res.sessionDir);
      this.dirty = true; // insights wrote derived artifacts
    }
    if (end || this.pendingTurns >= this.cfg.batch.maxTurns) {
      flushed = this.flush(`capture ${evt.session_id}`);
    } else {
      this.scheduleFlush();
    }
    return { ok: true, newTurns: res.newTurns, flushed };
  }

  private scheduleFlush(): void {
    if (this.commitTimer) return;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = undefined;
      this.flush('batch interval');
    }, this.cfg.batch.maxIntervalMs);
    this.commitTimer.unref?.();
  }

  /** Commit (and push when configured) all buffered store changes. Returns whether a commit landed. */
  flush(message: string): boolean {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
    }
    if (!this.dirty || !this.git) {
      this.dirty = false;
      this.pendingTurns = 0;
      return false;
    }
    const r = this.git.sync(message);
    this.dirty = false;
    this.pendingTurns = 0;
    if (r.commit.committed) this.stats.commits++;
    return r.commit.committed;
  }

  status(): DaemonStatus {
    return {
      running: this.running,
      socketPath: this.cfg.socketPath,
      storeDir: this.cfg.storeDir,
      events: this.stats.events,
      turns: this.stats.turns,
      commits: this.stats.commits,
      sessions: [...this.sessions],
    };
  }

  async stop(): Promise<void> {
    this.watcher?.stop();
    await this.receiver?.stop();
    this.receiver = undefined;
    for (const t of this.triggerTimers.values()) clearTimeout(t);
    this.triggerTimers.clear();
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
    }
    this.flush('daemon shutdown');
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    if (existsSync(this.cfg.socketPath)) {
      try {
        rmSync(this.cfg.socketPath);
      } catch {
        /* ignore */
      }
    }
    this.running = false;
  }
}
