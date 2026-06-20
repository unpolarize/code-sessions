import { describe, expect, it } from 'vitest';
import { overridesFromFlags, parseFlags } from './cliargs';

describe('parseFlags', () => {
  it('parses --key value, --key=value, and boolean flags', () => {
    const f = parseFlags(['--store', '/s', '--provider=ollama', '--push', '--since', '2026-06']);
    expect(f).toEqual({ store: '/s', provider: 'ollama', push: true, since: '2026-06' });
  });
});

describe('overridesFromFlags', () => {
  it('maps flags onto config overrides', () => {
    const o = overridesFromFlags({
      store: '/s',
      host: 'box',
      remote: 'git@x:y.git',
      push: true,
      provider: 'claude',
      mode: 'on-stop',
      model: 'opus',
    });
    expect(o.storeDir).toBe('/s');
    expect(o.host).toBe('box');
    expect(o.git).toEqual({ remote: 'git@x:y.git', autoPush: true });
    expect(o.insights).toEqual({ provider: 'claude', mode: 'on-stop', model: 'opus' });
  });

  it('omits unset groups', () => {
    expect(overridesFromFlags({ store: '/s' })).toEqual({ storeDir: '/s' });
  });
});
