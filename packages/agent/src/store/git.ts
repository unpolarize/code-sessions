import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Git-backed store operations. Append-only + host-keyed paths mean writers never
 * target the same file, so commits/merges are conflict-free by construction.
 * `.gitattributes` adds merge=union for the few append-only manifests.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
  reason?: string;
}

const FALLBACK_IDENTITY = ['-c', 'user.name=code-sessions', '-c', 'user.email=agent@code-sessions'];

const GITIGNORE = `# code-sessions store — runtime + local-only artifacts
.daemon/
*.tmp
# large externalized blobs stay local in MVP-1 (LFS/object-store in MVP-2)
raw/
`;

const GITATTRIBUTES = `# append-only manifests merge by union so concurrent appends both survive
*.jsonl merge=union
telemetry/*.jsonl merge=union
`;

export class GitStore {
  constructor(
    private readonly dir: string,
    private readonly opts: { remote?: string; autoPush?: boolean } = {},
  ) {}

  private run(args: string[], extraEnv?: Record<string, string>): GitResult {
    const res = spawnSync('git', ['-C', this.dir, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    });
    return {
      ok: res.status === 0,
      stdout: (res.stdout ?? '').trim(),
      stderr: (res.stderr ?? '').trim(),
      code: res.status ?? -1,
    };
  }

  isRepo(): boolean {
    return existsSync(join(this.dir, '.git'));
  }

  /** Initialize the store repo (idempotent): git init, connect remote (adopting
   * its existing history on a fresh clone so a second machine continues the same
   * store instead of forking), then write scaffolding files if still absent. */
  init(): void {
    if (!this.isRepo()) {
      const r = spawnSync('git', ['init', '-b', 'main', this.dir], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
    }
    // Connect + adopt remote BEFORE writing scaffolding, so an adopted checkout
    // doesn't collide with untracked .gitignore/.gitattributes we'd write.
    if (this.opts.remote) {
      this.ensureRemote(this.opts.remote);
      this.adoptRemoteIfEmpty();
    }
    const giPath = join(this.dir, '.gitignore');
    if (!existsSync(giPath)) writeFileSync(giPath, GITIGNORE);
    const gaPath = join(this.dir, '.gitattributes');
    if (!existsSync(gaPath)) writeFileSync(gaPath, GITATTRIBUTES);
  }

  /** When this clone has no commits yet, pull the remote's existing store so we
   * continue its history (multi-machine) rather than starting a divergent one.
   * No-op for an empty/unreachable remote. */
  private adoptRemoteIfEmpty(): void {
    if (this.run(['rev-parse', '--verify', 'HEAD']).ok) return; // already has local history
    if (!this.run(['fetch', 'origin']).ok) return; // empty or unreachable remote
    if (!this.run(['rev-parse', '--verify', 'origin/main']).ok) return; // remote has no main
    this.run(['reset', '--hard', 'origin/main']);
    this.run(['branch', '--set-upstream-to=origin/main', 'main']);
  }

  ensureRemote(remote: string): void {
    const existing = this.run(['remote', 'get-url', 'origin']);
    if (existing.ok) {
      if (existing.stdout !== remote) this.run(['remote', 'set-url', 'origin', remote]);
    } else {
      this.run(['remote', 'add', 'origin', remote]);
    }
  }

  hasChanges(): boolean {
    const r = this.run(['status', '--porcelain']);
    return r.stdout.length > 0;
  }

  /** Stage everything and commit. Returns committed:false when the tree is clean. */
  commit(message: string): CommitResult {
    this.run(['add', '-A']);
    if (!this.hasChanges() && !this.hasStaged()) {
      return { committed: false, reason: 'nothing to commit' };
    }
    let r = this.run(['commit', '-m', message]);
    if (!r.ok && /Please tell me who you are|user\.email|empty ident/i.test(r.stderr)) {
      r = this.run([...FALLBACK_IDENTITY, 'commit', '-m', message]);
    }
    if (!r.ok) {
      // "nothing to commit" race
      if (/nothing to commit/i.test(r.stdout + r.stderr)) {
        return { committed: false, reason: 'nothing to commit' };
      }
      return { committed: false, reason: r.stderr || r.stdout };
    }
    const sha = this.run(['rev-parse', 'HEAD']).stdout;
    return { committed: true, sha };
  }

  private hasStaged(): boolean {
    // diff --cached exits 1 when there are staged changes
    const r = this.run(['diff', '--cached', '--quiet']);
    return r.code === 1;
  }

  currentBranch(): string {
    return this.run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'main';
  }

  /** Rebase local commits on top of the remote (clean by construction for host-keyed paths). */
  pull(): GitResult {
    return this.run(['pull', '--rebase', '--autostash', 'origin', this.currentBranch()]);
  }

  push(): GitResult {
    return this.run(['push', '-u', 'origin', this.currentBranch()]);
  }

  /** Convenience: commit, and when a remote+autoPush are configured, pull --rebase then push. */
  sync(message: string): { commit: CommitResult; pushed: boolean; pushError?: string } {
    const commit = this.commit(message);
    if (!commit.committed) return { commit, pushed: false };
    if (!this.opts.remote || !this.opts.autoPush) return { commit, pushed: false };
    // best-effort: integrate remote first, then push
    this.pull();
    const p = this.push();
    return { commit, pushed: p.ok, ...(p.ok ? {} : { pushError: p.stderr }) };
  }
}
