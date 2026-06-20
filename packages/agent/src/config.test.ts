import { describe, expect, it } from 'vitest';
import { defaultConfig, resolveConfig } from './config';

describe('config', () => {
  it('builds sane defaults under a home dir', () => {
    const c = defaultConfig('/home/x', 'box');
    expect(c.host).toBe('box');
    expect(c.storeDir).toBe('/home/x/.sessions');
    expect(c.runtimeDir).toBe('/home/x/.sessions/.daemon');
    expect(c.socketPath).toBe('/home/x/.sessions/.daemon/daemon.sock');
    expect(c.statePath).toBe('/home/x/.sessions/.daemon/state.json');
    expect(c.claudeProjectsDir).toBe('/home/x/.claude/projects');
    expect(c.insights.provider).toBe('none');
  });

  it('deep-merges overrides without dropping sibling keys', () => {
    const base = defaultConfig('/home/x', 'box');
    const merged = resolveConfig(base, {
      host: 'other',
      batch: { maxTurns: 1 },
      insights: { provider: 'ollama', model: 'llama3' },
    });
    expect(merged.host).toBe('other');
    expect(merged.batch.maxTurns).toBe(1);
    expect(merged.batch.maxIntervalMs).toBe(base.batch.maxIntervalMs); // sibling preserved
    expect(merged.insights.provider).toBe('ollama');
    expect(merged.insights.mode).toBe('off'); // sibling preserved
  });

  it('re-derives runtime paths when storeDir is overridden', () => {
    const merged = resolveConfig(defaultConfig('/home/x', 'box'), { storeDir: '/tmp/store' });
    expect(merged.runtimeDir).toBe('/tmp/store/.daemon');
    expect(merged.socketPath).toBe('/tmp/store/.daemon/daemon.sock');
    expect(merged.statePath).toBe('/tmp/store/.daemon/state.json');
  });
});
