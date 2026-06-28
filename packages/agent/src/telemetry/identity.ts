import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import type { AttributionConfig } from '../config';

/**
 * Identity attribution: who ran a session. Derived from the session's repo
 * (git user.email/name) or the OS user, and overridable via explicit config
 * (an external identity provider can supply this in production).
 * Git/OS access is injected so resolution is deterministic to test.
 */

export interface Identity {
  /** developer identity → enduser.id */
  enduser?: string;
}

export interface IdentityDeps {
  /** git user.email / user.name, scoped to a repo root when given */
  gitUser(root?: string): { email?: string; name?: string };
  /** the OS account name */
  osUser(): string | undefined;
}

function gitConfigValue(root: string | undefined, key: string): string | undefined {
  const scope = root ? ['-C', root] : [];
  const r = spawnSync('git', [...scope, 'config', key], { encoding: 'utf8' });
  const out = (r.stdout ?? '').trim();
  return r.status === 0 && out.length > 0 ? out : undefined;
}

export const defaultIdentityDeps: IdentityDeps = {
  gitUser: (root) => ({
    email: gitConfigValue(root, 'user.email'),
    name: gitConfigValue(root, 'user.name'),
  }),
  osUser: () => {
    try {
      return userInfo().username || undefined;
    } catch {
      return process.env.USER ?? process.env.USERNAME ?? undefined;
    }
  },
};

/**
 * Resolve identity for a session. Enduser precedence: explicit config → git
 * user.email → git user.name → OS user. Resolves to nothing → omitted entirely.
 */
export function resolveIdentity(
  repo: { label?: string; root?: string } | undefined,
  cfg: AttributionConfig,
  deps: IdentityDeps = defaultIdentityDeps,
): Identity {
  const gu = deps.gitUser(repo?.root);
  const enduser = cfg.enduser ?? gu.email ?? gu.name ?? deps.osUser();

  const id: Identity = {};
  if (enduser) id.enduser = enduser;
  return id;
}
