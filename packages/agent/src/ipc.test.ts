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

  it('normalizes tool fields from Claude (snake_case) payloads', () => {
    const e = parseHookEvent({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      tool_name: 'Edit',
      tool_input: { file_path: 'a.ts' },
      tool_use_id: 'tc1',
    });
    expect(e).toMatchObject({ event: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'tc1' });
    expect(e?.tool_input).toEqual({ file_path: 'a.ts' });
  });

  it('canonicalizes Grok snake_case event names to PascalCase (real payload)', () => {
    // Verified against a live grok run: hookEventName values are snake_case.
    expect(parseHookEvent({ hookEventName: 'post_tool_use', sessionId: 's', toolName: 'read_file' })?.event).toBe('PostToolUse');
    expect(parseHookEvent({ hookEventName: 'session_start', sessionId: 's' })?.event).toBe('SessionStart');
    expect(parseHookEvent({ hookEventName: 'stop', sessionId: 's' })?.event).toBe('Stop');
    expect(parseHookEvent({ hookEventName: 'session_end', sessionId: 's' })?.event).toBe('SessionEnd');
    // Claude/Codex PascalCase passes through unchanged
    expect(parseHookEvent({ hook_event_name: 'PostToolUse', session_id: 's' })?.event).toBe('PostToolUse');
  });

  it('canonicalized Grok events flow through isSessionEndEvent', () => {
    const stop = parseHookEvent({ hookEventName: 'stop', sessionId: 's' })!;
    expect(isSessionEndEvent(stop.event)).toBe(true);
  });

  it('normalizes tool fields from Grok (camelCase) payloads', () => {
    const e = parseHookEvent({
      hookEventName: 'PreToolUse',
      sessionId: 's',
      toolName: 'read_file',
      toolInput: { path: 'a.ts' },
      toolUseId: 'g1',
    });
    expect(e).toMatchObject({ event: 'PreToolUse', tool_name: 'read_file', tool_use_id: 'g1' });
    expect(e?.tool_input).toEqual({ path: 'a.ts' });
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
