import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Install code-sessions hook shims into Claude Code settings.json. Each event
 * runs `code-sessions hook`, which forwards the hook payload to the daemon
 * socket. Existing hooks are preserved.
 */

export const DEFAULT_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
] as const;

interface HookEntry {
  type: 'command';
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
type SettingsHooks = Record<string, HookGroup[]>;
interface Settings {
  hooks?: SettingsHooks;
  [k: string]: unknown;
}

function groupHasCommand(groups: HookGroup[], command: string): boolean {
  return groups.some((g) => g.hooks?.some((h) => h.command === command));
}

/** Pure merge: add our command to each requested event if not already present. */
export function mergeHooks(
  settings: Settings,
  command: string,
  events: readonly string[] = DEFAULT_HOOK_EVENTS,
): { settings: Settings; added: string[] } {
  const next: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = next.hooks as SettingsHooks;
  const added: string[] = [];
  for (const event of events) {
    const groups = hooks[event] ? [...hooks[event]!] : [];
    if (groupHasCommand(groups, command)) {
      hooks[event] = groups;
      continue;
    }
    groups.push({ matcher: '', hooks: [{ type: 'command', command }] });
    hooks[event] = groups;
    added.push(event);
  }
  return { settings: next, added };
}

export interface InstallResult {
  settingsPath: string;
  command: string;
  added: string[];
}

export function installHooks(
  settingsPath: string,
  command: string,
  events: readonly string[] = DEFAULT_HOOK_EVENTS,
): InstallResult {
  let settings: Settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    } catch {
      settings = {};
    }
  }
  const { settings: merged, added } = mergeHooks(settings, command, events);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  return { settingsPath, command, added };
}

/** Grok reads `~/.grok/hooks/*.json` (Claude-style, always-trusted) — verified firing live. */
export function grokHooksPath(home = homedir()): string {
  return join(home, '.grok', 'hooks', 'code-sessions.json');
}

/**
 * Install code-sessions hooks for Grok. Grok's global hooks dir uses the exact same
 * `{ hooks: { <Event>: [{ hooks: [{ type, command }] }] } }` document as Claude
 * settings.json, so we reuse the same merge/write. Idempotent.
 */
export function installGrokHooks(
  command: string,
  opts: { path?: string; events?: readonly string[]; home?: string } = {},
): InstallResult {
  return installHooks(opts.path ?? grokHooksPath(opts.home), command, opts.events ?? DEFAULT_HOOK_EVENTS);
}
