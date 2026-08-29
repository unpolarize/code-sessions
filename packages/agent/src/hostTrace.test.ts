import { describe, expect, it, beforeEach } from 'vitest';
import { Span, formatTraceHuman, initTrace, recentTraces, resetTraceForTests } from './hostTrace';

describe('hostTrace (cs)', () => {
  beforeEach(() => {
    resetTraceForTests();
    initTrace('cs', '0.13.2');
  });

  it('tags SLOW on cs.rpc.session.list over 100ms', () => {
    let t = 0;
    const s = new Span('cs.rpc.session.list', 'ab', () => t);
    t = 180;
    s.end();
    const done = recentTraces().at(-1);
    expect(done?.slow).toBe(true);
    expect(done?.src).toBe('cs');
    expect(formatTraceHuman(done!)).toMatch(/DONE cs.rpc.session.list 180ms SLOW/);
  });
});
