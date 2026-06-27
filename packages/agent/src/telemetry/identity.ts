import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import type { AttributionConfig } from '../config';

/**
 * Identity attribution: who ran a session and which team/department owns it.
 * Resolved from the session's repo (git user.email/name), the OS user, or explicit
 * config (an external identity/org provider can supply these in production).
 * Git/OS access is injected so resolution is deterministic to test.
 */

export interface Identity {
  /** developer identity → enduser.id */
  enduser?: string;
  /** owning team → organization.team */
  team?: string;
  /** owning department → organization.department */
  department?: string;
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
 * user.email → git user.name → OS user. Team/department: per-repo mapping →
 * static config. Attributes that resolve to nothing are omitted entirely.
 */
export function resolveIdentity(
  repo: { label?: string; root?: string } | undefined,
  cfg: AttributionConfig,
  deps: IdentityDeps = defaultIdentityDeps,
): Identity {
  const gu = deps.gitUser(repo?.root);
  const enduser = cfg.enduser ?? gu.email ?? gu.name ?? deps.osUser();

  const mapped = repo?.label ? cfg.teamByRepo?.[repo.label] : undefined;
  const team = mapped?.team ?? cfg.team;
  const department = mapped?.department ?? cfg.department;

  const id: Identity = {};
  if (enduser) id.enduser = enduser;
  if (team) id.team = team;
  if (department) id.department = department;
  return id;
}
