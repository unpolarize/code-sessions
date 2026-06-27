import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Turn } from '@unpolarize/code-sessions-schema';

/**
 * Dynamic project = repository resolution. Replaces the hardcoded path-convention
 * heuristic (…/projects/<id>) with the top-most enclosing `.git` work-tree root,
 * so cost attribution is accurate regardless of where a repo is checked out.
 *
 * Git/FS access is injected (`RepoResolverDeps`) so the pure walk + label logic is
 * fast and deterministic to test; the daemon uses the real-filesystem defaults.
 */

export interface RepoInfo {
  /** absolute path of the top-most enclosing git work-tree root */
  root: string;
  /** `org/repo` parsed from the origin remote, else the root's basename */
  label: string;
  /** origin remote URL when available */
  url?: string;
}

export interface RepoResolverDeps {
  /** true when `dir` is a git work-tree root (contains a `.git` entry) */
  isGitRoot(dir: string): boolean;
  /** origin remote URL for a git root, or undefined when none/unavailable */
  remoteUrl(root: string): string | undefined;
}

export const defaultRepoDeps: RepoResolverDeps = {
  isGitRoot: (dir) => existsSync(join(dir, '.git')),
  remoteUrl: (root) => {
    const r = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    const out = (r.stdout ?? '').trim();
    return r.status === 0 && out.length > 0 ? out : undefined;
  },
};

/**
 * Ascend from `startPath` to the filesystem root, returning the OUTERMOST directory
 * that is a git work-tree root. Outermost (not innermost) so nested submodules /
 * worktrees attribute to the umbrella repo.
 */
export function topmostGitRoot(startPath: string, deps: RepoResolverDeps): string | undefined {
  let dir = startPath;
  let top: string | undefined;
  for (;;) {
    if (deps.isGitRoot(dir)) top = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return top;
}

/** `org/repo` from a remote URL (ssh or https, with/without `.git`), else the root basename. */
export function repoLabel(root: string, url: string | undefined): string {
  if (url) {
    const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
    if (m?.[1]) return m[1];
  }
  return basename(root);
}

/**
 * Resolves filesystem paths to repository identity, with three memoization layers
 * so resolution is cheap across the thousands of paths a single session touches:
 *  - `isRootByDir`  — each directory is stat-ed for `.git` at most once, ever.
 *  - `rootByDir`    — each path/dir resolves to its top-most root once; the whole
 *                     ancestor chain is cached in one walk (sibling/child paths
 *                     then hit the cache with zero further stats).
 *  - `infoByRoot`   — the `git remote` lookup + label runs once per repo root.
 */
export class RepoResolver {
  private rootByDir = new Map<string, string | undefined>();
  private isRootByDir = new Map<string, boolean>();
  private infoByRoot = new Map<string, RepoInfo>();

  constructor(private readonly deps: RepoResolverDeps = defaultRepoDeps) {}

  resolve(path: string): RepoInfo | undefined {
    const root = this.rootForPath(path);
    if (!root) return undefined;
    let info = this.infoByRoot.get(root);
    if (!info) {
      const url = this.deps.remoteUrl(root);
      info = { root, label: repoLabel(root, url), ...(url ? { url } : {}) };
      this.infoByRoot.set(root, info);
    }
    return info;
  }

  private isRoot(dir: string): boolean {
    let v = this.isRootByDir.get(dir);
    if (v === undefined) {
      v = this.deps.isGitRoot(dir);
      this.isRootByDir.set(dir, v);
    }
    return v;
  }

  /** Top-most enclosing git root for `start`, caching the answer for every dir on the walk. */
  private rootForPath(start: string): string | undefined {
    const cached = this.rootByDir.get(start);
    if (cached !== undefined || this.rootByDir.has(start)) return cached;

    const chain: string[] = [];
    for (let cur = start; ; ) {
      chain.push(cur);
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    // Outermost (most ancestral) git root = first hit scanning from the filesystem root down.
    let topIndex = -1;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (this.isRoot(chain[i]!)) {
        topIndex = i;
        break;
      }
    }
    const top = topIndex >= 0 ? chain[topIndex]! : undefined;
    // Everything at/below the top root resolves to it; anything above it has no enclosing root.
    for (let i = 0; i < chain.length; i++) {
      this.rootByDir.set(chain[i]!, i <= topIndex ? top : undefined);
    }
    return top;
  }
}

/** The file path a tool call touched (Edit/Write/Read), if any. */
export function touchedPath(input: unknown): string | undefined {
  const o = input as { file_path?: string; path?: string } | undefined;
  const fp = o?.file_path ?? o?.path;
  return typeof fp === 'string' ? fp : undefined;
}

/**
 * The session's dominant repository: the one with the most Edit/Write hits across
 * turns. Ties (and the no-edits case) break toward the cwd's repo.
 */
export function dominantRepo(
  turns: Turn[],
  cwd: string | undefined,
  resolver: RepoResolver = new RepoResolver(),
): RepoInfo | undefined {
  const counts = new Map<string, number>();
  const infoByLabel = new Map<string, RepoInfo>();
  for (const t of turns) {
    for (const c of t.tool_calls) {
      if (c.name !== 'Edit' && c.name !== 'Write') continue;
      const fp = touchedPath(c.input);
      if (!fp) continue;
      const info = resolver.resolve(fp);
      if (!info) continue;
      counts.set(info.label, (counts.get(info.label) ?? 0) + 1);
      infoByLabel.set(info.label, info);
    }
  }
  const cwdInfo = cwd ? resolver.resolve(cwd) : undefined;
  if (counts.size === 0) return cwdInfo;

  let best: string | undefined;
  let bestN = -1;
  for (const [label, n] of counts) {
    const isCwd = cwdInfo?.label === label;
    if (n > bestN || (n === bestN && isCwd)) {
      best = label;
      bestN = n;
    }
  }
  return best ? infoByLabel.get(best) : cwdInfo;
}
