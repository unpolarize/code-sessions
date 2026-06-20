import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeSessionsConfig } from '../config';
import type { CommandResult } from '../commands';
import { GitStore } from '../store/git';
import { renderDigest } from './digest';
import { computeReport } from './rollup';
import { renderSite } from './site';

export interface AnalyticsOptions {
  now?: string;
}

/** Compute MVP-2 rollups and write report.json + digest.md + index.html under analytics/. */
export async function cmdAnalytics(
  cfg: CodeSessionsConfig,
  opts: AnalyticsOptions = {},
): Promise<CommandResult> {
  const now = opts.now ?? new Date().toISOString();
  const report = computeReport(cfg.storeDir, now);

  const dir = join(cfg.storeDir, 'analytics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, 'digest.md'), renderDigest(report));
  writeFileSync(join(dir, 'index.html'), renderSite(report));

  const git = new GitStore(cfg.storeDir, {
    ...(cfg.git.remote ? { remote: cfg.git.remote } : {}),
    autoPush: cfg.git.autoPush,
  });
  if (git.isRepo()) git.sync(`analytics rollup (${report.sessions} sessions)`);

  return {
    code: 0,
    output: `Analytics written for ${report.sessions} session(s) → ${dir}`,
  };
}
