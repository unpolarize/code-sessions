import type { HookEvent } from '../ipc';
import { attr, resource, SCOPE, type KeyValue } from './otlp';

/**
 * Real-time OTel **log** records emitted the moment a lifecycle hook arrives —
 * so tool decisions, prompts, and session start/end are captured live, not only
 * in the post-session trace/metric export. Fire-and-forget: the daemon posts
 * these to `/v1/logs` with a short timeout and continues regardless.
 */

/** Map a hook event name to its `code_sessions.*` log event name. */
export function hookLogEventName(event: string): string {
  switch (event) {
    case 'SessionStart':
      return 'code_sessions.session.start';
    case 'Stop':
    case 'SessionEnd':
      return 'code_sessions.session.end';
    case 'SubagentStop':
      return 'code_sessions.subagent.stop';
    case 'UserPromptSubmit':
      return 'code_sessions.turn.prompt';
    case 'PreToolUse':
      return 'code_sessions.tool.decision';
    case 'PostToolUse':
      return 'code_sessions.tool.result';
    default:
      return 'code_sessions.hook';
  }
}

/** Max chars of tool input emitted (only when emitContent is on). */
const MAX_TOOL_INPUT = 8000;

/** Build an OTLP/HTTP JSON logs request for a single hook event. */
export function buildHookLogPayload(
  evt: HookEvent,
  serviceName: string,
  host: string,
  nowMs: number,
  opts: { agent?: string; emitContent?: boolean } = {},
): unknown {
  const name = hookLogEventName(evt.event);
  const timeNano = `${nowMs}000000`;

  const attrs: KeyValue[] = [
    attr('event.name', name),
    attr('code_sessions.hook.event', evt.event),
    attr('session.id', evt.session_id),
    attr('gen_ai.conversation.id', evt.session_id),
  ];
  if (opts.agent) attrs.push(attr('gen_ai.system', opts.agent));
  if (evt.cwd) attrs.push(attr('cwd', evt.cwd));
  if (evt.tool_name) attrs.push(attr('gen_ai.tool.name', evt.tool_name));
  if (evt.tool_use_id) attrs.push(attr('gen_ai.tool.call.id', evt.tool_use_id));
  if (opts.emitContent && evt.tool_input !== undefined) {
    attrs.push(attr('code_sessions.tool.input', JSON.stringify(evt.tool_input).slice(0, MAX_TOOL_INPUT)));
  }

  return {
    resourceLogs: [
      {
        resource: resource(serviceName, host),
        scopeLogs: [
          {
            scope: SCOPE,
            logRecords: [
              {
                timeUnixNano: timeNano,
                observedTimeUnixNano: timeNano,
                severityNumber: 9, // INFO
                severityText: 'INFO',
                body: { stringValue: name },
                attributes: attrs,
              },
            ],
          },
        ],
      },
    ],
  };
}
