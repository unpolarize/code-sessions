import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { AgentKind } from '@unpolarize/code-sessions-schema';

export type InsightsProvider = 'none' | 'fake' | 'claude' | 'grok' | 'ollama';
export type InsightsMode = 'off' | 'on-stop' | 'per-turn';

/**
 * Identity + custom association-property enrichment for the export (all optional, additive).
 * The exporter already derives identity (host, OS user, git user → `enduser`) and the
 * project (git repo) on its own; this block lets you attach arbitrary association
 * properties on top, globally and/or per project.
 */
export interface AttributionConfig {
  /** explicit enduser id; overrides the derived git/OS identity */
  enduser?: string;
  /** custom association properties emitted verbatim on every span + metric point */
  custom?: Record<string, string>;
  /**
   * per-project association properties, keyed by the resolved project (repo) label
   * (`org/repo` from the origin remote, else the directory name). Merged over `custom`
   * when a session's dominant project matches.
   */
  customByRepo?: Record<string, Record<string, string>>;
}

export interface CodeSessionsConfig {
  /** logical host id; keys store paths so two machines never collide */
  host: string;
  agent: AgentKind;
  /** root of the git-backed store, e.g. ~/.sessions */
  storeDir: string;
  /** gitignored dir under storeDir for daemon runtime files (socket, state) */
  runtimeDir: string;
  /** unix socket the daemon listens on for hook events */
  socketPath: string;
  /** daemon bookkeeping state file */
  statePath: string;
  /** SQLite index (projection of the git store) for fast queries */
  indexPath: string;
  /** where Claude Code writes its native JSONL transcripts */
  claudeProjectsDir: string;
  batch: {
    /** flush after this many buffered turns */
    maxTurns: number;
    /** flush at least this often (ms) */
    maxIntervalMs: number;
  };
  hygiene: {
    /** externalize a turn's text once it exceeds this many bytes */
    maxTurnBytes: number;
    scrubSecrets: boolean;
  };
  git: {
    /** remote URL for the store; when set the daemon pushes after commit */
    remote?: string;
    autoCommit: boolean;
    autoPush: boolean;
  };
  insights: {
    provider: InsightsProvider;
    mode: InsightsMode;
    /** model/tag passed to the provider (e.g. ollama model name) */
    model?: string;
    /** predefined per-turn category taxonomy (configurable); enables classification when set */
    categories?: string[];
    /** classify each turn into one `categories` value via the ollama classifier */
    classifyTurns?: boolean;
    /** ollama model for per-turn classification (defaults to `model`, then llama3.1) */
    classifierModel?: string;
  };
  telemetry: {
    /** export captured sessions as OTLP to a collector */
    enabled: boolean;
    /** OTLP/HTTP base URL (paths /v1/traces, /v1/metrics are appended) */
    endpoint: string;
    serviceName: string;
    timeoutMs: number;
    /** override the trace path appended to `endpoint` (default `/v1/traces`) */
    tracesPath?: string;
    /** override the metric path appended to `endpoint` (default `/v1/metrics`) */
    metricsPath?: string;
    /** extra HTTP headers sent on every export (auth / tenancy / routing) */
    headers?: Record<string, string>;
    /** emit first-prompt / last-reply (and per-turn) text as span content. Off by
     * default — message content can be sensitive. */
    emitContent?: boolean;
    /** set false to export traces only (skip metrics) for trace-only backends */
    emitMetrics?: boolean;
  };
  /** identity + custom association-property enrichment for the export */
  attribution: AttributionConfig;
  /** continuous capture of agents that can't push hooks (codex, grok) — see SourceWatchConfig */
  capture: CaptureConfig;
}

export interface CaptureConfig {
  /**
   * Poll-based capture for agents that write session files locally but can't push
   * hook events to the daemon (codex, grok). The daemon periodically discovers and
   * imports new/changed sessions, giving them the same store + telemetry as Claude.
   * No-op when an agent isn't installed (its sessions dir is absent).
   */
  watch: SourceWatchConfig;
  /**
   * Use a coding agent's own OTLP telemetry as a capture trigger. The daemon runs a
   * loopback OTLP receiver; point an agent's exporter at it
   * (`CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<port>`)
   * and each inbound export re-captures + re-emits that session's GenAI-semconv traces.
   */
  otelTrigger: OtelTriggerConfig;
}

export interface OtelTriggerConfig {
  enabled: boolean;
  /** loopback TCP port the daemon's OTLP receiver listens on (point the agent here) */
  port: number;
}

export interface SourceWatchConfig {
  /** import Codex CLI rollouts from ~/.codex/sessions */
  codex: boolean;
  /** import Grok CLI sessions from ~/.grok/sessions */
  grok: boolean;
  /** how often the daemon re-scans the source dirs (ms) */
  intervalMs: number;
}

export function defaultConfig(home = homedir(), host = hostname()): CodeSessionsConfig {
  const storeDir = join(home, '.sessions');
  const runtimeDir = join(storeDir, '.daemon');
  return {
    host,
    agent: 'claude-code',
    storeDir,
    runtimeDir,
    socketPath: join(runtimeDir, 'daemon.sock'),
    statePath: join(runtimeDir, 'state.json'),
    indexPath: join(runtimeDir, 'index.db'),
    claudeProjectsDir: join(home, '.claude', 'projects'),
    batch: { maxTurns: 8, maxIntervalMs: 5000 },
    hygiene: { maxTurnBytes: 64 * 1024, scrubSecrets: true },
    git: { autoCommit: true, autoPush: false },
    insights: { provider: 'none', mode: 'off' },
    telemetry: {
      enabled: true,
      endpoint: 'http://localhost:4318',
      serviceName: 'code-sessions',
      timeoutMs: 2000,
    },
    attribution: {},
    capture: {
      watch: { codex: true, grok: true, intervalMs: 30000 },
      otelTrigger: { enabled: false, port: 4318 },
    },
  };
}

/**
 * Deep-merge a partial override onto a base config (pure; no IO). Runtime paths
 * (runtimeDir/socketPath/statePath) are re-derived from storeDir unless the
 * override sets them explicitly, so changing storeDir keeps them consistent.
 */
export function resolveConfig(
  base: CodeSessionsConfig,
  override: DeepPartial<CodeSessionsConfig> = {},
): CodeSessionsConfig {
  const merged: CodeSessionsConfig = {
    ...base,
    ...stripUndefined(override),
    batch: { ...base.batch, ...stripUndefined(override.batch) },
    hygiene: { ...base.hygiene, ...stripUndefined(override.hygiene) },
    git: { ...base.git, ...stripUndefined(override.git) },
    insights: { ...base.insights, ...stripUndefined(override.insights) },
    telemetry: {
      ...base.telemetry,
      ...stripUndefined(override.telemetry),
      ...(base.telemetry.headers || override.telemetry?.headers
        ? { headers: { ...base.telemetry.headers, ...(override.telemetry?.headers ?? {}) } }
        : {}),
    },
    attribution: { ...base.attribution, ...stripUndefined(override.attribution) },
    capture: {
      ...base.capture,
      ...stripUndefined(override.capture),
      watch: { ...base.capture.watch, ...stripUndefined(override.capture?.watch) },
      otelTrigger: { ...base.capture.otelTrigger, ...stripUndefined(override.capture?.otelTrigger) },
    },
  };
  if (override.storeDir && override.runtimeDir === undefined) {
    merged.runtimeDir = join(merged.storeDir, '.daemon');
  }
  if (merged.socketPath === base.socketPath && override.socketPath === undefined) {
    merged.socketPath = join(merged.runtimeDir, 'daemon.sock');
  }
  if (merged.statePath === base.statePath && override.statePath === undefined) {
    merged.statePath = join(merged.runtimeDir, 'state.json');
  }
  if (merged.indexPath === base.indexPath && override.indexPath === undefined) {
    merged.indexPath = join(merged.runtimeDir, 'index.db');
  }
  return merged;
}

/** Load config from defaults <- <store>/config.json <- env <- explicit overrides. */
export function loadConfig(override: DeepPartial<CodeSessionsConfig> = {}): CodeSessionsConfig {
  let cfg = defaultConfig();
  // The store dir may be redirected by env or an explicit override (e.g. the
  // --store CLI flag). Resolve it first so we load that store's config.json,
  // not the default ~/.sessions one.
  const storeDir = override.storeDir ?? process.env.CODE_SESSIONS_STORE ?? cfg.storeDir;
  const configPath = join(storeDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const fileCfg = JSON.parse(readFileSync(configPath, 'utf8')) as DeepPartial<CodeSessionsConfig>;
      cfg = resolveConfig(cfg, fileCfg);
    } catch {
      // ignore malformed config; defaults win
    }
  }
  cfg = resolveConfig(cfg, envOverrides());
  cfg = resolveConfig(cfg, override);
  return cfg;
}

function envOverrides(): DeepPartial<CodeSessionsConfig> {
  const o: DeepPartial<CodeSessionsConfig> = {};
  const env = process.env;
  if (env.CODE_SESSIONS_STORE) o.storeDir = env.CODE_SESSIONS_STORE;
  if (env.CODE_SESSIONS_HOST) o.host = env.CODE_SESSIONS_HOST;
  if (env.CODE_SESSIONS_REMOTE) o.git = { remote: env.CODE_SESSIONS_REMOTE };
  if (env.CODE_SESSIONS_INSIGHTS_PROVIDER)
    o.insights = { provider: env.CODE_SESSIONS_INSIGHTS_PROVIDER as InsightsProvider };
  if (env.CODE_SESSIONS_CATEGORIES) {
    const categories = env.CODE_SESSIONS_CATEGORIES.split(',').map((c) => c.trim()).filter(Boolean);
    o.insights = { ...(o.insights ?? {}), categories, classifyTurns: true };
  }
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) o.telemetry = { endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT };
  if (env.CODE_SESSIONS_TELEMETRY === '0' || env.CODE_SESSIONS_TELEMETRY === 'false')
    o.telemetry = { ...(o.telemetry ?? {}), enabled: false };
  // Extra OTLP headers as JSON, e.g. CODE_SESSIONS_OTLP_HEADERS='{"Authorization":"Bearer …"}'
  if (env.CODE_SESSIONS_OTLP_HEADERS) {
    try {
      o.telemetry = { ...(o.telemetry ?? {}), headers: JSON.parse(env.CODE_SESSIONS_OTLP_HEADERS) };
    } catch {
      // ignore malformed header JSON
    }
  }
  return o;
}

function stripUndefined<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
