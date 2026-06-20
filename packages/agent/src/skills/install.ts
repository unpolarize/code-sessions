import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildClaudeSkill, buildPromptFile } from './templates';

export type SkillAgent = 'claude' | 'codex' | 'grok' | 'all';

export interface SkillInstallResult {
  installed: string[];
}

/** Resolve where each agent expects user skills/prompts. */
function targetsFor(agent: SkillAgent, home: string): { agent: string; path: string; content: string }[] {
  const out: { agent: string; path: string; content: string }[] = [];
  const want = (a: string) => agent === 'all' || agent === a;
  if (want('claude')) {
    out.push({
      agent: 'claude',
      path: join(home, '.claude', 'skills', 'cs-label-session', 'SKILL.md'),
      content: buildClaudeSkill(),
    });
  }
  if (want('codex')) {
    out.push({
      agent: 'codex',
      path: join(home, '.codex', 'prompts', 'cs-label-session.md'),
      content: buildPromptFile(),
    });
  }
  if (want('grok')) {
    out.push({
      agent: 'grok',
      path: join(home, '.grok', 'prompts', 'cs-label-session.md'),
      content: buildPromptFile(),
    });
  }
  return out;
}

/** Install the CS labeling skill into the requested agents' skill/prompt dirs. */
export function installSkills(
  opts: { agent?: SkillAgent; home?: string } = {},
): SkillInstallResult {
  const home = opts.home ?? homedir();
  const installed: string[] = [];
  for (const t of targetsFor(opts.agent ?? 'all', home)) {
    mkdirSync(dirname(t.path), { recursive: true });
    writeFileSync(t.path, t.content);
    installed.push(t.path);
  }
  return { installed };
}
