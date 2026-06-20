import { describe, expect, it } from 'vitest';
import { isSessionEndEvent, parseHookEvent } from './ipc';

describe('parseHookEvent', () => {
  it('accepts snake_case payloads', () => {
    const e = parseHookEvent({
      event: 'PostToolUse',
      session_id: 's',
      transcript_path: '/t.jsonl',
      cwd: '/p',
    });
    expect(e).toEqual({ event: 'PostToolUse', session_id: 's', transcript_path: '/t.jsonl', cwd: '/p' });
  });

  it('accepts Claude hook_event_name + sessionId aliases', () => {
    const e = parseHookEvent({ hook_event_name: 'Stop', sessionId: 's', transcriptPath: '/t' });
    expect(e?.event).toBe('Stop');
    expect(e?.session_id).toBe('s');
    expect(e?.transcript_path).toBe('/t');
  });

  it('rejects payloads missing event or session id', () => {
    expect(parseHookEvent({ event: 'Stop' })).toBeNull();
    expect(parseHookEvent({ session_id: 's' })).toBeNull();
    expect(parseHookEvent(null)).toBeNull();
  });
});

describe('isSessionEndEvent', () => {
  it('flags lifecycle-end events', () => {
    expect(isSessionEndEvent('Stop')).toBe(true);
    expect(isSessionEndEvent('SubagentStop')).toBe(true);
    expect(isSessionEndEvent('PostToolUse')).toBe(false);
  });
});
