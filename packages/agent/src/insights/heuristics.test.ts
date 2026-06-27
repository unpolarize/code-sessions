import { describe, expect, it } from 'vitest';
import type { Turn } from '@unpolarize/code-sessions-schema';
import { deriveIntent, deriveProjects, deriveSignals, deriveTags, guessTopic } from './heuristics';
import { RepoResolver } from './repo';

function turn(i: number, over: Partial<Turn> = {}): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 's',
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: 't',
    role: 'assistant',
    text: '',
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

describe('deriveSignals', () => {
  it('flags a stuck loop on repeated identical actions', () => {
    const turns = [
      turn(0, { tool_calls: [{ name: 'Bash', input: { command: 'ls' } }] }),
      turn(1, { tool_calls: [{ name: 'Bash', input: { command: 'ls' } }] }),
      turn(2, { tool_calls: [{ name: 'Bash', input: { command: 'ls' } }] }),
    ];
    const s = deriveSignals(turns);
    expect(s.some((x) => x.kind === 'stuck-loop' && x.severity === 'warn')).toBe(true);
  });

  it('flags error-recovery when a turn mentions an error', () => {
    const turns = [turn(0, { role: 'tool', text: 'TypeError: cannot read foo' })];
    expect(deriveSignals(turns).some((x) => x.kind === 'error-recovery')).toBe(true);
  });

  it('flags high-cost turns', () => {
    const turns = [turn(0, { telemetry: { cost_usd: 0.9 } })];
    expect(deriveSignals(turns).some((x) => x.kind === 'high-cost-turn')).toBe(true);
  });

  it('flags tool-heavy sessions', () => {
    const turns = [
      turn(0, { tool_calls: [{ name: 'Read' }, { name: 'Edit' }] }),
      turn(1, { tool_calls: [{ name: 'Bash' }] }),
    ];
    expect(deriveSignals(turns).some((x) => x.kind === 'tool-heavy')).toBe(true);
  });

  it('produces nothing notable for a calm short session', () => {
    const turns = [turn(0, { role: 'user', text: 'hi' }), turn(1, { text: 'hello' })];
    expect(deriveSignals(turns)).toEqual([]);
  });
});

describe('guessTopic / deriveTags', () => {
  it('guesses a topic from the first user turn', () => {
    const topic = guessTopic([turn(0, { role: 'user', text: 'Fix the bug in foo.ts please now' })]);
    expect(topic).toContain('Fix the bug');
  });

  it('strips the slash-command wrapper and uses <command-name> + <command-args>', () => {
    const topic = guessTopic([
      turn(0, {
        role: 'user',
        text: '<command-message>load</command-message><command-name>/load</command-name><command-args>review the new requirements</command-args>',
      }),
    ]);
    expect(topic).toBe('/load review the new requirements');
    expect(topic).not.toMatch(/command-message|command-name|command-args/);
  });

  it('strips a system-reminder block from a plain first prompt', () => {
    const topic = guessTopic([
      turn(0, { role: 'user', text: '<system-reminder>context here</system-reminder>Fix the parser crash now' }),
    ]);
    expect(topic).toBe('Fix the parser crash now');
  });

  it('collects distinct tool names as tags', () => {
    const tags = deriveTags([
      turn(0, { tool_calls: [{ name: 'Read' }, { name: 'Edit' }] }),
      turn(1, { tool_calls: [{ name: 'Read' }] }),
    ]);
    expect(tags.sort()).toEqual(['Edit', 'Read']);
  });
});

describe('deriveIntent', () => {
  it('classifies intent from the first user prompt', () => {
    expect(deriveIntent([turn(0, { role: 'user', text: 'fix the parser bug' })])).toBe('bugfix');
    expect(deriveIntent([turn(0, { role: 'user', text: 'add a dark mode feature' })])).toBe('feature');
    expect(deriveIntent([turn(0, { role: 'user', text: 'refactor the auth module' })])).toBe('refactor');
    expect(deriveIntent([turn(0, { role: 'user', text: 'research the best vector db' })])).toBe('research');
    expect(deriveIntent([turn(0, { role: 'user', text: 'xyzzy' })])).toBe('other');
    expect(deriveIntent([])).toBeUndefined();
  });
});

describe('deriveProjects', () => {
  it('derives project ids from edited file paths (path-convention fallback)', () => {
    const projects = deriveProjects([
      turn(0, { tool_calls: [{ name: 'Edit', input: { file_path: '/Users/x/projects/foo/a.ts' } }] }),
      turn(1, { tool_calls: [{ name: 'Write', input: { file_path: '/Users/x/projects/ai/bar/b.ts' } }] }),
      turn(2, { tool_calls: [{ name: 'Read', input: { path: '/Users/x/docs/notes.md' } }] }),
    ]);
    expect(projects).toEqual(['ai/bar', 'docs', 'foo']);
  });

  it('labels by top-most git repo, falling back to path convention when no repo encloses the path', () => {
    const resolver = new RepoResolver({
      isGitRoot: (d) => d === '/work/acme',
      remoteUrl: () => 'git@github.com:acme/app.git',
    });
    const projects = deriveProjects(
      [
        turn(0, { tool_calls: [{ name: 'Edit', input: { file_path: '/work/acme/src/a.ts' } }] }),
        turn(1, { tool_calls: [{ name: 'Write', input: { file_path: '/Users/x/projects/foo/b.ts' } }] }),
      ],
      resolver,
    );
    expect(projects).toEqual(['acme/app', 'foo']);
  });
});
