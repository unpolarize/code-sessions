import type { SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';
import {
  attr,
  attributionMap,
  capContent,
  hexId,
  isoNano,
  resource,
  SCOPE,
  type Attribution,
  type KeyValue,
} from './otlp';

/**
 * GenAI-semantic-convention telemetry: model a session the way the OTel GenAI
 * spec does.
 *
 *   session / conversation  = a set of traces sharing `gen_ai.conversation.id`
 *   turn                    = one trace (one user request + the agent's work)
 *   invocation              = one span (an `invoke_agent` turn root, with child
 *                             `chat` LLM-invocation and `execute_tool` spans)
 *
 * Token/cost usage lives ONLY on the leaf `chat` spans, so summing them gives the
 * session total with no rollup double-counting. Span/trace ids are deterministic
 * hashes, so re-exporting a session is idempotent.
 */

/** OTel span kinds we use. */
const KIND_INTERNAL = 1;
const KIND_CLIENT = 3;

/** Map an internal agent id to a GenAI `gen_ai.provider.name`. */
export function providerFor(agent: string): string {
  const a = agent.toLowerCase();
  if (a.includes('claude')) return 'anthropic';
  if (a.includes('codex')) return 'openai';
  if (a.includes('grok')) return 'xai';
  return a || 'unknown';
}

/**
 * Group the store's role-records into conversational turns: a new turn begins at
 * each `user` message and runs through the assistant/tool records that follow.
 */
export function groupIntoTurns(turns: Turn[]): Turn[][] {
  const groups: Turn[][] = [];
  for (const t of turns) {
    if (t.role === 'user' || groups.length === 0) groups.push([t]);
    else groups[groups.length - 1]!.push(t);
  }
  return groups;
}

/** Build one OTLP trace per conversational turn (turn = trace, invocation = span). */
export function buildTurnTraces(
  session: SessionEnvelope,
  turns: Turn[],
  serviceName: string,
  attribution?: Attribution,
  turnCategories?: Map<number, string>,
  emitContent = false,
): unknown {
  const provider = providerFor(session.agent);
  const enrich = attribution ? attributionMap(attribution) : {};
  const enrichAttrs = Object.entries(enrich).map(([k, v]) => attr(k, v));
  const model = session.model;
  const spans: unknown[] = [];

  groupIntoTurns(turns).forEach((group, g) => {
    const traceId = hexId(`${session.session_id}:${g}`, 16);
    const rootId = hexId(`${session.session_id}:${g}:agent`, 8);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    // the conversational turn's category: first categorized record in the group
    const turnCat = group.map((t) => turnCategories?.get(t.turn_index)).find(Boolean);

    spans.push({
      traceId,
      spanId: rootId,
      name: `invoke_agent ${session.agent}`,
      kind: KIND_INTERNAL,
      startTimeUnixNano: isoNano(first.ts),
      endTimeUnixNano: isoNano(last.ts),
      attributes: [
        attr('gen_ai.operation.name', 'invoke_agent'),
        attr('gen_ai.agent.name', session.agent),
        attr('gen_ai.provider.name', provider),
        attr('gen_ai.conversation.id', session.session_id),
        attr('code_sessions.turn.index', g),
        ...(turnCat ? [attr('code_sessions.turn.category', turnCat)] : []),
        ...enrichAttrs,
        ...(emitContent && first.role === 'user' && first.text
          ? [attr('gen_ai.input.messages', capContent(first.text))]
          : []),
      ],
      status: {},
    });

    for (const t of group) {
      if (t.role !== 'assistant') continue;
      const chatId = hexId(`${session.session_id}:${g}:chat:${t.turn_index}`, 8);
      const cat = turnCategories?.get(t.turn_index);
      const chatAttrs: KeyValue[] = [
        attr('gen_ai.operation.name', 'chat'),
        attr('gen_ai.provider.name', provider),
        ...(model ? [attr('gen_ai.request.model', model)] : []),
        attr('gen_ai.usage.input_tokens', t.usage.input_tokens),
        attr('gen_ai.usage.output_tokens', t.usage.output_tokens),
        ...(t.usage.cache_read_tokens ? [attr('gen_ai.usage.cache_read_tokens', t.usage.cache_read_tokens)] : []),
        ...(t.usage.cache_write_tokens ? [attr('gen_ai.usage.cache_write_tokens', t.usage.cache_write_tokens)] : []),
        ...(t.telemetry?.cost_usd ? [attr('code_sessions.cost_usd', t.telemetry.cost_usd)] : []),
        ...(cat ? [attr('code_sessions.turn.category', cat)] : []),
        ...(emitContent && t.text ? [attr('gen_ai.output.messages', capContent(t.text))] : []),
      ];
      spans.push({
        traceId,
        spanId: chatId,
        parentSpanId: rootId,
        name: `chat ${model ?? session.agent}`,
        kind: KIND_CLIENT,
        startTimeUnixNano: isoNano(t.ts),
        endTimeUnixNano: isoNano(t.ts),
        attributes: chatAttrs,
        status: {},
      });

      t.tool_calls.forEach((tc, k) => {
        const toolId = hexId(`${session.session_id}:${g}:tool:${t.turn_index}:${k}`, 8);
        spans.push({
          traceId,
          spanId: toolId,
          parentSpanId: chatId,
          name: `execute_tool ${tc.name}`,
          kind: KIND_INTERNAL,
          startTimeUnixNano: isoNano(t.ts),
          endTimeUnixNano: isoNano(t.ts),
          attributes: [
            attr('gen_ai.operation.name', 'execute_tool'),
            attr('gen_ai.tool.name', tc.name),
            attr('gen_ai.tool.type', 'function'),
            ...(tc.id ? [attr('gen_ai.tool.call.id', String(tc.id))] : []),
          ],
          status: {},
        });
      });
    }
  });

  return { resourceSpans: [{ resource: resource(serviceName, session.host), scopeSpans: [{ scope: SCOPE, spans }] }] };
}

/**
 * Optional GenAI metrics: per-`chat` token usage as a Sum, so summing the data
 * points reproduces the session total (consistent with the trace `chat` spans —
 * aggregate from EITHER traces or metrics, not both).
 */
export function buildGenaiMetrics(
  session: SessionEnvelope,
  turns: Turn[],
  serviceName: string,
  attribution?: Attribution,
): unknown {
  const enrich = attribution ? attributionMap(attribution) : {};
  const base = [
    attr('gen_ai.conversation.id', session.session_id),
    attr('gen_ai.provider.name', providerFor(session.agent)),
    ...Object.entries(enrich).map(([k, v]) => attr(k, v)),
  ];
  const tokenPoints: unknown[] = [];
  const costPoints: unknown[] = [];
  groupIntoTurns(turns).forEach((group, g) => {
    for (const t of group) {
      if (t.role !== 'assistant') continue;
      const time = isoNano(t.ts);
      const at = [...base, attr('code_sessions.turn.index', g)];
      const pt = (type: string, val: number) => ({
        asInt: val,
        timeUnixNano: time,
        attributes: [...at, attr('gen_ai.token.type', type)],
      });
      tokenPoints.push(pt('input', t.usage.input_tokens), pt('output', t.usage.output_tokens));
      if (t.telemetry?.cost_usd) {
        costPoints.push({ asDouble: t.telemetry.cost_usd, timeUnixNano: time, attributes: at });
      }
    }
  });

  return {
    resourceMetrics: [
      {
        resource: resource(serviceName, session.host),
        scopeMetrics: [
          {
            scope: SCOPE,
            metrics: [
              {
                name: 'gen_ai.client.token.usage',
                unit: '{token}',
                sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: tokenPoints },
              },
              {
                name: 'code_sessions.cost_usd',
                unit: 'USD',
                sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: costPoints },
              },
            ],
          },
        ],
      },
    ],
  };
}
