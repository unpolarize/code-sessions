/**
 * Daemon task registry — the daemon-side twin of CSV's JobTracker
 * (architecture/tools/specs/2026-08-31-async-jobs-status-design.md R2/R4):
 * long-running daemon work (source-watcher imports, store git flushes,
 * backfills) is visible to clients via the `task.list` RPC instead of only
 * living in the daemon log. Pure — no I/O — so tests drive it directly.
 */

export type TaskPhase = 'running' | 'ok' | 'error';

export interface DaemonTask {
  id: string;
  title: string;
  phase: TaskPhase;
  startedAt: number;
  endedMs?: number;
  done?: number;
  total?: number;
  detail?: string;
  error?: string;
}

export interface TaskListResult {
  running: DaemonTask[];
  recent: DaemonTask[];
  /** Poll-based capture heartbeat, so clients can show "watcher alive". */
  watcher?: { lastScanAt: number; intervalMs: number };
}

export class TaskRegistry {
  private readonly running = new Map<string, DaemonTask>();
  private readonly recent: DaemonTask[] = [];
  private watcherBeat: { lastScanAt: number; intervalMs: number } | undefined;
  private seq = 0;

  constructor(
    private readonly cap = 20,
    private readonly now: () => number = Date.now,
  ) {}

  start(id: string, title: string): void {
    this.running.set(id, { id, title, phase: 'running', startedAt: this.now() });
  }

  progress(id: string, done: number, total: number): void {
    const t = this.running.get(id);
    if (!t) return;
    t.done = done;
    t.total = total;
  }

  finish(id: string, outcome: { detail?: string; error?: string } = {}): void {
    const t = this.running.get(id);
    if (!t) return;
    this.running.delete(id);
    this.push({
      ...t,
      phase: outcome.error ? 'error' : 'ok',
      endedMs: this.now() - t.startedAt,
      detail: outcome.detail,
      error: outcome.error,
    });
  }

  /** Record an already-completed unit of work (sync scans, flushes). */
  record(title: string, outcome: { detail?: string; error?: string; tookMs?: number } = {}): void {
    this.push({
      id: `${title}#${++this.seq}`,
      title,
      phase: outcome.error ? 'error' : 'ok',
      startedAt: this.now() - (outcome.tookMs ?? 0),
      endedMs: outcome.tookMs ?? 0,
      detail: outcome.detail,
      error: outcome.error,
    });
  }

  /** Every watcher tick, even a no-op one — clients render liveness. */
  watcherScan(intervalMs: number): void {
    this.watcherBeat = { lastScanAt: this.now(), intervalMs };
  }

  private push(t: DaemonTask): void {
    this.recent.unshift(t);
    if (this.recent.length > this.cap) this.recent.pop();
  }

  list(): TaskListResult {
    return {
      running: [...this.running.values()].sort((a, b) => a.startedAt - b.startedAt),
      recent: [...this.recent],
      watcher: this.watcherBeat,
    };
  }
}
