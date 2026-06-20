import type { DeepPartial, CodeSessionsConfig, InsightsProvider, InsightsMode } from './config';

export type Flags = Record<string, string | boolean>;

/** Minimal flag parser: --key value, --key=value, and bare --flag booleans. */
export function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    }
  }
  return flags;
}

export function overridesFromFlags(flags: Flags): DeepPartial<CodeSessionsConfig> {
  const o: DeepPartial<CodeSessionsConfig> = {};
  if (typeof flags.store === 'string') o.storeDir = flags.store;
  if (typeof flags.host === 'string') o.host = flags.host;
  if (typeof flags.remote === 'string') o.git = { remote: flags.remote };
  if (flags.push === true) o.git = { ...(o.git ?? {}), autoPush: true };
  const insights: DeepPartial<CodeSessionsConfig['insights']> = {};
  if (typeof flags.provider === 'string') insights.provider = flags.provider as InsightsProvider;
  if (typeof flags.mode === 'string') insights.mode = flags.mode as InsightsMode;
  if (typeof flags.model === 'string') insights.model = flags.model;
  if (Object.keys(insights).length > 0) o.insights = insights;
  const telemetry: DeepPartial<CodeSessionsConfig['telemetry']> = {};
  if (typeof flags.endpoint === 'string') telemetry.endpoint = flags.endpoint;
  if (flags['no-telemetry'] === true || flags['telemetry'] === false) telemetry.enabled = false;
  if (Object.keys(telemetry).length > 0) o.telemetry = telemetry;
  return o;
}

export const HELP = `code-sessions — headless cross-agent session capture

Usage: code-sessions <command> [flags]

Commands:
  init            Initialize the git-backed store (~/.sessions)
  start           Run the capture daemon (foreground)
  install-hooks   Install Claude Code hooks that feed the daemon
  install-skills  Install the cs-label-session skill into agents [--agent claude|codex|grok|all]
  hook            (internal) forward a hook payload from stdin to the daemon
  backfill        Import existing transcripts into the store [--agent claude|grok|codex|codebuild|all]
  reindex         (Re)derive insights for stored sessions  [--since YYYY-MM]
  export          Export stored sessions as OTLP to a collector  [--since YYYY-MM]
  index           (Re)build the internal SQLite index from the git store
  query           List recent sessions from the index  [--limit N] [--agent X]
  usage           Aggregated token/cost usage (totals/by-agent/by-day)  [--json]
  search          Full-text search session turns  <text> [--limit N]
  fork            Fork a session at a turn ("git for sessions")  <session-id> --at N [--id X]
  analytics       Compute MVP-2 rollups + digest into analytics/
  status          Show daemon/store status
  doctor          Environment checks

Flags:
  --store <dir>        store dir (default ~/.sessions)
  --host <name>        logical host id
  --remote <url>       git remote for the store
  --push               push after commit
  --provider <p>       insights provider: none|fake|claude|grok|ollama
  --mode <m>           insights mode: off|on-stop|per-turn
  --model <m>          provider model
  --since <YYYY-MM>    reindex/export: only sessions since month
  --endpoint <url>     OTLP/HTTP collector base (default http://localhost:4318)
  --no-telemetry       disable OTLP export
  --settings <path>    install-hooks: target settings.json
`;
