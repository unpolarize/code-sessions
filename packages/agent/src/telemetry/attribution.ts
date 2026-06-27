import type { Insights, SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';
import type { AttributionConfig } from '../config';
import { RepoResolver, dominantRepo } from '../insights/repo';
import { defaultIdentityDeps, resolveIdentity, type IdentityDeps } from './identity';
import type { Attribution } from './otlp';

/**
 * Build the attribution for a session by composing the three derived
 * sources: the dominant repository (top-most git root), the developer/team/dept
 * identity, and the session's intent/topic from insights/labels.json. Git/FS/OS
 * access is injectable so the composition is deterministic to test.
 */

export interface AttributionDeps {
  resolver?: RepoResolver;
  identity?: IdentityDeps;
}

export function sessionAttribution(
  envelope: SessionEnvelope,
  turns: Turn[],
  insights: Insights | undefined,
  cfg: AttributionConfig,
  deps: AttributionDeps = {},
): Attribution {
  const resolver = deps.resolver ?? new RepoResolver();
  const repo = dominantRepo(turns, envelope.project_path || undefined, resolver);
  const identity = resolveIdentity(
    repo ? { label: repo.label, root: repo.root } : undefined,
    cfg,
    deps.identity ?? defaultIdentityDeps,
  );

  const a: Attribution = { ...identity };
  if (insights?.intent) a.intent = insights.intent;
  if (insights?.topic) a.topic = insights.topic;
  if (repo) a.repo = repo.label;
  if (repo?.url) a.repoUrl = repo.url;
  if (cfg.custom && Object.keys(cfg.custom).length > 0) a.custom = cfg.custom;
  return a;
}
