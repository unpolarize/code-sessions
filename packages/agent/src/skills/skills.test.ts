import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '../test/tmp';
import { buildClaudeSkill, buildLabelSkillBody } from './templates';
import { installSkills } from './install';

describe('skill templates', () => {
  it('embeds the intent + signal taxonomy', () => {
    const body = buildLabelSkillBody();
    expect(body).toContain('feature | bugfix | refactor');
    expect(body).toContain('stuck-loop');
    expect(body).toContain('"projects"');
  });

  it('claude skill carries frontmatter', () => {
    const s = buildClaudeSkill();
    expect(s).toMatch(/^---\nname: cs-label-session/);
  });
});

describe('installSkills', () => {
  it('installs into all agents under the given home', () => {
    withTempDir((home) => {
      const res = installSkills({ agent: 'all', home });
      expect(res.installed).toHaveLength(3);
      expect(existsSync(join(home, '.claude', 'skills', 'cs-label-session', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'prompts', 'cs-label-session.md'))).toBe(true);
      expect(existsSync(join(home, '.grok', 'prompts', 'cs-label-session.md'))).toBe(true);
      const claude = readFileSync(join(home, '.claude', 'skills', 'cs-label-session', 'SKILL.md'), 'utf8');
      expect(claude).toContain('intent');
    });
  });

  it('can target a single agent', () => {
    withTempDir((home) => {
      const res = installSkills({ agent: 'claude', home });
      expect(res.installed).toHaveLength(1);
      expect(res.installed[0]).toContain('.claude');
    });
  });
});
