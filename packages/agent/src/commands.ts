import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeSessionsConfig } from './config';
import { CaptureEngine } from './capture';
import { Daemon } from './daemon';
import { FakeProvider } from './insights/provider';
import { labelSession, makeProvider, reindexStore } from './insights/labeler';
import { StateStore } from './state';
import { GitStore } from './store/git';
import { listSessionDirs, readEntries } from './store/scan';
import { installHooks } from './hooks/install';

export interface CommandResult {
  code: number;
  output: string;
}

function gitStoreFor(cfg: CodeSessionsConfig): GitStore {
  return new GitStore(cfg.storeDir, {
    ...(cfg.git.remote ? { remote: cfg.git.remote } : {}),
    autoPush: cfg.git.autoPush,
  });
}

/** Collect every Claude transcript (<sessionId>.jsonl) under a projects dir. */
export function listClaudeTranscripts(
  projectsDir: string,
  maxDepth = 3,
): { sessionId: string; path: string }[] {
  const out: { sessionId: string; path: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || !existsSync(dir)) return;
    for (const e of readEntries(dir)) {
      const name = String(e.name);
      if (e.isFile() && name.endsWith('.jsonl')) {
        out.push({ sessionId: name.replace(/\.jsonl$/, ''), path: join(dir, name) });
      } else if (e.isDirectory()) {
        walk(join(dir, name), depth + 1);
      }
    }
  };
  walk(projectsDir, 0);
  return out;
}

export function cmdInit(cfg: CodeSessionsConfig): CommandResult {
  const git = gitStoreFor(cfg);
  git.init();
  const configPath = join(cfg.storeDir, 'config.json');
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      `${JSON.stringify({ insights: cfg.insights, batch: cfg.batch, hygiene: cfg.hygiene }, null, 2)}\n`,
    );
  }
  git.commit('init store');
  return { code: 0, output: `Initialized store at ${cfg.storeDir}` };
}

export function cmdStatus(cfg: CodeSessionsConfig): CommandResult {
  const state = new StateStore(cfg.statePath);
  const sessions = Object.keys(state.all());
  const stored = listSessionDirs(cfg.storeDir);
  const socketUp = existsSync(cfg.socketPath);
  const lines = [
    `store:      ${cfg.storeDir}`,
    `host:       ${cfg.host}`,
    `daemon:     ${socketUp ? 'running (socket present)' : 'not running'}`,
    `tracked:    ${sessions.length} session(s) in state`,
    `stored:     ${stored.length} session(s) in store`,
    `insights:   ${cfg.insights.provider} / ${cfg.insights.mode}`,
    `remote:     ${cfg.git.remote ?? '(none)'}  autoPush=${cfg.git.autoPush}`,
  ];
  return { code: 0, output: lines.join('\n') };
}

export async function cmdBackfill(
  cfg: CodeSessionsConfig,
  opts: { projectsDir?: string } = {},
): Promise<CommandResult> {
  const projectsDir = opts.projectsDir ?? cfg.claudeProjectsDir;
  const transcripts = listClaudeTranscripts(projectsDir);
  const engine = new CaptureEngine(cfg, new StateStore(cfg.statePath));
  let turns = 0;
  for (const t of transcripts) {
    const res = engine.captureSession(t.sessionId, t.path);
    turns += res.newTurns;
  }
  const git = gitStoreFor(cfg);
  git.init();
  git.commit(`backfill ${transcripts.length} sessions`);
  return {
    code: 0,
    output: `Backfilled ${transcripts.length} session(s), ${turns} turn(s) from ${projectsDir}`,
  };
}

export async function cmdReindex(
  cfg: CodeSessionsConfig,
  opts: { since?: string } = {},
): Promise<CommandResult> {
  const provider = makeProvider(cfg) ?? new FakeProvider();
  const res = await reindexStore(cfg, provider, opts.since ? { sinceMonth: opts.since } : {});
  const git = gitStoreFor(cfg);
  if (git.isRepo()) git.sync(`insights reindex (${res.count})`);
  return { code: 0, output: `Reindexed ${res.count} session(s) with provider=${provider.name}` };
}

export function cmdInstallHooks(
  cfg: CodeSessionsConfig,
  opts: { settingsPath?: string; command?: string } = {},
): CommandResult {
  const home = cfg.claudeProjectsDir.replace(/\/projects\/?$/, '');
  const settingsPath = opts.settingsPath ?? join(home, 'settings.json');
  const command = opts.command ?? 'code-sessions hook';
  const res = installHooks(settingsPath, command);
  return {
    code: 0,
    output:
      res.added.length > 0
        ? `Installed hooks (${res.added.join(', ')}) → ${settingsPath}`
        : `Hooks already present → ${settingsPath}`,
  };
}

export function cmdDoctor(cfg: CodeSessionsConfig): CommandResult {
  const checks: [string, boolean][] = [
    ['store dir exists', existsSync(cfg.storeDir)],
    ['store is git repo', existsSync(join(cfg.storeDir, '.git'))],
    ['daemon socket present', existsSync(cfg.socketPath)],
    ['claude projects dir', existsSync(cfg.claudeProjectsDir)],
  ];
  const lines = checks.map(([name, ok]) => `${ok ? '✓' : '✗'} ${name}`);
  const code = checks.every(([, ok]) => ok) ? 0 : 1;
  return { code, output: lines.join('\n') };
}

/** Long-running: start the daemon, wire insights on session-end, resolve with a stop() handle. */
export async function startDaemon(cfg: CodeSessionsConfig): Promise<Daemon> {
  const provider = makeProvider(cfg);
  const deps =
    provider && cfg.insights.mode !== 'off'
      ? {
          onSessionEnd: async (sessionId: string, sessionDir: string) => {
            await labelSession(sessionDir, { sessionId, host: cfg.host }, provider);
          },
        }
      : {};
  const daemon = new Daemon(cfg, deps);
  await daemon.start();
  return daemon;
}
