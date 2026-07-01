import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '../test/tmp';
import { DEFAULT_HOOK_EVENTS, installGrokHooks, installHooks, mergeHooks } from './install';

describe('installGrokHooks', () => {
  it('writes ~/.grok/hooks/code-sessions.json (Claude-style doc) with our command, idempotently', () => {
    withTempDir((home) => {
      const r1 = installGrokHooks('code-sessions hook', { home });
      expect(r1.settingsPath).toBe(join(home, '.grok', 'hooks', 'code-sessions.json'));
      expect(r1.added).toEqual([...DEFAULT_HOOK_EVENTS]);
      const doc = JSON.parse(readFileSync(r1.settingsPath, 'utf8'));
      expect(doc.hooks.PostToolUse[0].hooks[0].command).toBe('code-sessions hook');
      expect(installGrokHooks('code-sessions hook', { home }).added).toEqual([]); // idempotent
    });
  });
});

describe('mergeHooks', () => {
  it('adds our command to each event without clobbering existing hooks', () => {
    const existing = {
      model: 'opus',
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command' as const, command: 'other-tool' }] }] },
    };
    const { settings, added } = mergeHooks(existing, 'code-sessions hook');
    expect(added).toEqual([...DEFAULT_HOOK_EVENTS]);
    // preserves unrelated settings
    expect((settings as { model: string }).model).toBe('opus');
    // preserves the pre-existing Stop hook AND adds ours
    const stop = settings.hooks!.Stop!;
    expect(stop.some((g) => g.hooks.some((h) => h.command === 'other-tool'))).toBe(true);
    expect(stop.some((g) => g.hooks.some((h) => h.command === 'code-sessions hook'))).toBe(true);
  });

  it('is idempotent (no duplicate command on re-run)', () => {
    const first = mergeHooks({}, 'code-sessions hook');
    const second = mergeHooks(first.settings, 'code-sessions hook');
    expect(second.added).toEqual([]);
    for (const event of DEFAULT_HOOK_EVENTS) {
      const groups = second.settings.hooks![event]!;
      const count = groups.filter((g) =>
        g.hooks.some((h) => h.command === 'code-sessions hook'),
      ).length;
      expect(count).toBe(1);
    }
  });
});

describe('installHooks', () => {
  it('writes a merged settings.json file', () => {
    withTempDir((dir) => {
      const settingsPath = join(dir, 'settings.json');
      const res = installHooks(settingsPath, 'code-sessions hook');
      expect(res.added.length).toBeGreaterThan(0);
      const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(written.hooks.PostToolUse[0].hooks[0].command).toBe('code-sessions hook');
    });
  });
});
