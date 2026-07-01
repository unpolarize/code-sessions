import { describe, expect, it } from 'vitest';
import { buildHookLogPayload, hookLogEventName } from './logs';

describe('hookLogEventName', () => {
  it('maps lifecycle hook events to code_sessions log event names', () => {
    expect(hookLogEventName('SessionStart')).toBe('code_sessions.session.start');
    expect(hookLogEventName('Stop')).toBe('code_sessions.session.end');
    expect(hookLogEventName('SessionEnd')).toBe('code_sessions.session.end');
    expect(hookLogEventName('SubagentStop')).toBe('code_sessions.subagent.stop');
    expect(hookLogEventName('UserPromptSubmit')).toBe('code_sessions.turn.prompt');
    expect(hookLogEventName('PreToolUse')).toBe('code_sessions.tool.decision');
    expect(hookLogEventName('PostToolUse')).toBe('code_sessions.tool.result');
    expect(hookLogEventName('Whatever')).toBe('code_sessions.hook');
  });
});

const rec = (p: any) => p.resourceLogs[0].scopeLogs[0].logRecords[0];
const sv = (p: any, k: string) => rec(p).attributes.find((a: any) => a.key === k)?.value.stringValue;

describe('buildHookLogPayload', () => {
  it('builds an OTLP log record with the real-time timestamp + session/tool attributes', () => {
    const p = buildHookLogPayload(
      { event: 'PostToolUse', session_id: 's1', tool_name: 'Edit', tool_use_id: 'tc1', cwd: '/w' },
      'code-sessions',
      'box-a',
      1_700_000_000_000,
      { agent: 'claude-code' },
    ) as any;
    expect(rec(p).body.stringValue).toBe('code_sessions.tool.result');
    expect(rec(p).timeUnixNano).toBe('1700000000000000000');
    expect(sv(p, 'session.id')).toBe('s1');
    expect(sv(p, 'gen_ai.conversation.id')).toBe('s1');
    expect(sv(p, 'gen_ai.system')).toBe('claude-code');
    expect(sv(p, 'gen_ai.tool.name')).toBe('Edit');
    expect(sv(p, 'gen_ai.tool.call.id')).toBe('tc1');
    expect(sv(p, 'code_sessions.hook.event')).toBe('PostToolUse');
    // host on the resource
    expect(p.resourceLogs[0].resource.attributes.find((a: any) => a.key === 'host.name').value.stringValue).toBe('box-a');
  });

  it('gates tool_input content behind emitContent', () => {
    const args = { event: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } } as const;
    const has = (p: any) => rec(p).attributes.some((a: any) => a.key === 'code_sessions.tool.input');
    expect(has(buildHookLogPayload(args, 'cs', 'h', 1, {}))).toBe(false);
    expect(has(buildHookLogPayload(args, 'cs', 'h', 1, { emitContent: true }))).toBe(true);
  });
});
