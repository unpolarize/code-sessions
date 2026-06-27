import { describe, expect, it } from 'vitest';
import type { Turn } from '@unpolarize/code-sessions-schema';
import { RepoResolver, dominantRepo, repoLabel, topmostGitRoot, type RepoResolverDeps } from './repo';

function fakeDeps(roots: string[], urls: Record<string, string> = {}): RepoResolverDeps {
  return { isGitRoot: (d) => roots.includes(d), remoteUrl: (r) => urls[r] };
}

function turn(i: number, over: Partial<Turn> = {}): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 's',
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: 't',
    role: 'assistant',
    text: '',
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

describe('topmostGitRoot', () => {
  it('returns the outermost enclosing git root (umbrella over a nested submodule)', () => {
    const deps = fakeDeps(['/a/umbrella', '/a/umbrella/sub']);
    expect(topmostGitRoot('/a/umbrella/sub/src/file.ts', deps)).toBe('/a/umbrella');
  });

  it('returns undefined when no git root encloses the path', () => {
    expect(topmostGitRoot('/x/y/z.ts', fakeDeps([]))).toBeUndefined();
  });
});

describe('repoLabel', () => {
  it('parses org/repo from ssh and https remotes (with or without .git)', () => {
    expect(repoLabel('/p/cs', 'git@github.com:unpolarize/code-sessions.git')).toBe('unpolarize/code-sessions');
    expect(repoLabel('/p/cs', 'https://github.com/unpolarize/code-sessions.git')).toBe('unpolarize/code-sessions');
    expect(repoLabel('/p/cs', 'https://github.com/unpolarize/code-sessions')).toBe('unpolarize/code-sessions');
  });

  it('falls back to the directory basename when there is no remote', () => {
    expect(repoLabel('/p/my-thing', undefined)).toBe('my-thing');
  });
});

describe('RepoResolver', () => {
  it('resolves a path to its repo label + url and caches the remote lookup per root', () => {
    let calls = 0;
    const deps: RepoResolverDeps = {
      isGitRoot: (d) => d === '/r',
      remoteUrl: () => {
        calls++;
        return 'git@github.com:o/r.git';
      },
    };
    const r = new RepoResolver(deps);
    expect(r.resolve('/r/a/b.ts')).toEqual({ root: '/r', label: 'o/r', url: 'git@github.com:o/r.git' });
    expect(r.resolve('/r/c/d.ts')?.label).toBe('o/r');
    expect(calls).toBe(1); // remote resolved once per root, not per path
  });

  it('returns undefined for a path outside any repo', () => {
    expect(new RepoResolver(fakeDeps([])).resolve('/nowhere/x.ts')).toBeUndefined();
  });

  it('memoizes directory resolution so isGitRoot runs once per dir, not once per file', () => {
    let isGitCalls = 0;
    const deps: RepoResolverDeps = {
      isGitRoot: (d) => {
        isGitCalls++;
        return d === '/r';
      },
      remoteUrl: () => 'git@github.com:o/r.git',
    };
    const r = new RepoResolver(deps);
    r.resolve('/r/a/b/c1.ts');
    r.resolve('/r/a/b/c2.ts'); // same dir
    r.resolve('/r/a/b/d/e.ts'); // deeper dir, shares ancestors
    const afterWarmup = isGitCalls;
    r.resolve('/r/a/b/c3.ts'); // every ancestor already resolved
    expect(isGitCalls).toBe(afterWarmup); // zero new stats for already-walked ancestors
    // each distinct directory on the chains is stat-ed at most once
    expect(afterWarmup).toBeLessThanOrEqual(7);
  });
});

describe('dominantRepo', () => {
  it('picks the repo with the most Edit/Write hits, tiebreaking on cwd', () => {
    const deps = fakeDeps(['/r1', '/r2'], {
      '/r1': 'git@github.com:o/one.git',
      '/r2': 'git@github.com:o/two.git',
    });
    const resolver = new RepoResolver(deps);
    const turns = [
      turn(0, { tool_calls: [{ name: 'Edit', input: { file_path: '/r1/a.ts' } }] }),
      turn(1, { tool_calls: [{ name: 'Write', input: { file_path: '/r1/b.ts' } }] }),
      turn(2, { tool_calls: [{ name: 'Edit', input: { file_path: '/r2/c.ts' } }] }),
    ];
    expect(dominantRepo(turns, undefined, resolver)?.label).toBe('o/one');
  });

  it('returns undefined when no touched path resolves to a repo', () => {
    const turns = [turn(0, { tool_calls: [{ name: 'Edit', input: { file_path: '/x/y.ts' } }] })];
    expect(dominantRepo(turns, undefined, new RepoResolver(fakeDeps([])))).toBeUndefined();
  });
});
