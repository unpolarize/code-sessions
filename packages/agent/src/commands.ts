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
import { exportSession, exportStore } from './telemetry/exporter';
import { discoverGrokSessions, parseGrokSession } from './adapters/grok';
import { discoverCodexSessions, parseCodexSession } from './adapters/codex';
import { writeImportedSession } from './adapters/import';

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

export type BackfillAgent = 'claude' | 'grok' | 'codex' | 'all';

export async function cmdBackfill(
  cfg: CodeSessionsConfig,
  opts: { projectsDir?: string; agent?: BackfillAgent } = {},
): Promise<CommandResult> {
  const agent = opts.agent ?? 'claude';
  const parts: string[] = [];
  let sessions = 0;
  let turns = 0;

  if (agent === 'claude' || agent === 'all') {
    const projectsDir = opts.projectsDir ?? cfg.claudeProjectsDir;
    const transcripts = listClaudeTranscripts(projectsDir);
    const engine = new CaptureEngine(cfg, new StateStore(cfg.statePath));
    let t = 0;
    for (const tr of transcripts) t += engine.captureSession(tr.sessionId, tr.path).newTurns;
    sessions += transcripts.length;
    turns += t;
    parts.push(`claude: ${transcripts.length} sessions / ${t} turns`);
  }

  if (agent === 'grok' || agent === 'all') {
    const found = discoverGrokSessions();
    let n = 0;
    let t = 0;
    for (const info of found) {
      const imported = parseGrokSession(info, cfg.host);
      if (!imported) continue;
      t += writeImportedSession(cfg, imported).turns;
      n++;
    }
    sessions += n;
    turns += t;
    parts.push(`grok: ${n} sessions / ${t} turns`);
  }

  if (agent === 'codex' || agent === 'all') {
    const found = discoverCodexSessions();
    let n = 0;
    let t = 0;
    for (const info of found) {
      const imported = parseCodexSession(info, cfg.host);
      if (!imported) continue;
      t += writeImportedSession(cfg, imported).turns;
      n++;
    }
    sessions += n;
    turns += t;
    parts.push(`codex: ${n} sessions / ${t} turns`);
  }

  const git = gitStoreFor(cfg);
  git.init();
  git.commit(`backfill (${agent}): ${sessions} sessions`);
  return { code: 0, output: `Backfilled ${sessions} session(s), ${turns} turn(s) — ${parts.join(', ')}` };
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

export async function cmdExport(
  cfg: CodeSessionsConfig,
  opts: { since?: string } = {},
): Promise<CommandResult> {
  if (!cfg.telemetry.enabled) {
    return { code: 0, output: 'Telemetry export disabled (telemetry.enabled=false)' };
  }
  const res = await exportStore(cfg, opts.since ? { sinceMonth: opts.since } : {});
  return {
    code: 0,
    output: `Exported ${res.exported}/${res.total} session(s) to ${cfg.telemetry.endpoint} (${res.failed} failed)`,
  };
}

/** Long-running: start the daemon, wire insights + telemetry on session-end. */
export async function startDaemon(cfg: CodeSessionsConfig): Promise<Daemon> {
  const provider = makeProvider(cfg);
  const wantInsights = provider && cfg.insights.mode !== 'off';
  const wantTelemetry = cfg.telemetry.enabled;

  const deps =
    wantInsights || wantTelemetry
      ? {
          onSessionEnd: async (sessionId: string, sessionDir: string) => {
            if (wantInsights && provider) {
              await labelSession(sessionDir, { sessionId, host: cfg.host }, provider);
            }
            if (wantTelemetry) {
              await exportSession(cfg, sessionDir);
            }
          },
        }
      : {};
  const daemon = new Daemon(cfg, deps);
  await daemon.start();
  return daemon;
}
