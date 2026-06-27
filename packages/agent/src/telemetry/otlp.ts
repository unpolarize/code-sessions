import { createHash } from 'node:crypto';
import type { SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';

/**
 * Minimal OTLP/HTTP JSON exporter — emits standard OpenTelemetry traces +
 * metrics for captured sessions to any OTLP collector, with no SDK dependency.
 * One trace per session (root span + a child span per turn) + token/cost metrics.
 */

type AnyValue =
  | { stringValue: string }
  | { intValue: number }
  | { doubleValue: number }
  | { boolValue: boolean };

interface KeyValue {
  key: string;
  value: AnyValue;
}

function attr(key: string, value: string | number | boolean): KeyValue {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  return Number.isInteger(value)
    ? { key, value: { intValue: value } }
    : { key, value: { doubleValue: value } };
}

/**
 * High-cardinality attribution carried on spans + metric data points.
 * Maps onto OTel GenAI semconv keys so a backend can group by any axis.
 */
export interface Attribution {
  /** session intent enum → gen_ai.conversation.intent */
  intent?: string;
  /** free-text topic → gen_ai.conversation.topic */
  topic?: string;
  /** resolved repo label (org/repo) → code.repository */
  repo?: string;
  /** repo remote URL → vcs.repository.url */
  repoUrl?: string;
  /** developer identity → enduser.id */
  enduser?: string;
  /** owning team → organization.team */
  team?: string;
  /** owning department → organization.department */
  department?: string;
  /** arbitrary user-defined attributes, emitted verbatim under their own keys */
  custom?: Record<string, string>;
}

/** Flat attribution map (semconv keys → value) used for both span attributes and a
 * single JSON `metadata` attribute (some backends fold it into one groupable column). */
function attributionMap(a: Attribution): Record<string, string> {
  const m: Record<string, string> = {};
  if (a.intent) m['gen_ai.conversation.intent'] = a.intent;
  if (a.topic) m['gen_ai.conversation.topic'] = a.topic;
  if (a.repo) m['code.repository'] = a.repo;
  if (a.repoUrl) m['vcs.repository.url'] = a.repoUrl;
  if (a.enduser) m['enduser.id'] = a.enduser;
  if (a.team) m['organization.team'] = a.team;
  if (a.department) m['organization.department'] = a.department;
  for (const [k, v] of Object.entries(a.custom ?? {})) {
    if (k && typeof v === 'string' && v.length > 0) m[k] = v;
  }
  return m;
}

/**
 * OTel KeyValue attributes for the attribution set (omits absent fields).
 * Emits each field as a flat semconv attribute (for the trace UI) AND a single
 * `metadata` attribute holding the whole map as JSON — some backends fold a
 * `metadata` attribute into one groupable column.
 *
 * `extra` merges additional groupable keys (e.g. agent, per-session cost) into
 * both the flat attrs and the metadata bag, so a backend can group by them even
 * though they are not standard gen_ai metrics.
 */
function attributionAttrs(a: Attribution | undefined, extra: Record<string, string> = {}): KeyValue[] {
  const map = { ...(a ? attributionMap(a) : {}), ...extra };
  const out: KeyValue[] = Object.entries(map).map(([k, v]) => attr(k, v));
  if (out.length > 0) out.push(attr('metadata', JSON.stringify(map)));
  return out;
}

function hexId(input: string, bytes: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, bytes * 2);
}

/** Max characters of turn text emitted as span content (keeps spans small). */
const MAX_CONTENT_CHARS = 8000;

/** Truncate content for span input/output, marking elision. */
function capContent(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_CONTENT_CHARS)}… [truncated ${text.length - MAX_CONTENT_CHARS} chars]`;
}

/**
 * Standard OTel GenAI-semconv content attributes that backends can render as a
 * span's input/output: indexed `gen_ai.prompt.{i}.{role,content}` (→ input) and
 * `gen_ai.completion.{i}.{role,content}` (→ output). Absent text emits nothing.
 */
function contentAttrs(input?: { role: string; text: string }, output?: { role: string; text: string }): KeyValue[] {
  const out: KeyValue[] = [];
  if (input && input.text) {
    out.push(attr('gen_ai.prompt.0.role', input.role), attr('gen_ai.prompt.0.content', capContent(input.text)));
  }
  if (output && output.text) {
    out.push(
      attr('gen_ai.completion.0.role', output.role),
      attr('gen_ai.completion.0.content', capContent(output.text)),
    );
  }
  return out;
}

/** ISO-8601 → unix nanoseconds as a string (avoids float precision loss). */
export function isoNano(ts: string | undefined): string {
  if (!ts) return '0';
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? '0' : `${ms}000000`;
}

const SCOPE = { name: 'code-sessions', version: '0.1.0' };

function resource(serviceName: string, host: string): { attributes: KeyValue[] } {
  return {
    attributes: [
      attr('service.name', serviceName),
      attr('host.name', host),
      attr('telemetry.sdk.name', 'code-sessions'),
      attr('telemetry.sdk.language', 'nodejs'),
    ],
  };
}

function sumUsage(turns: Turn[]) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const t of turns) {
    u.input += t.usage.input_tokens;
    u.output += t.usage.output_tokens;
    u.cacheRead += t.usage.cache_read_tokens;
    u.cacheWrite += t.usage.cache_write_tokens;
    u.cost += t.telemetry?.cost_usd ?? 0;
  }
  return u;
}

export function buildTracePayload(
  session: SessionEnvelope,
  turns: Turn[],
  serviceName: string,
  attribution?: Attribution,
  turnCategories?: Map<number, string>,
  emitContent = false,
): unknown {
  const traceId = hexId(session.session_id, 16);
  const rootId = hexId(`${session.session_id}:root`, 8);
  const totals = sumUsage(turns);

  // Optional span input/output: first user prompt + last assistant reply, so the
  // session shows readable input/output. Off by default (content can be sensitive).
  const firstUser = emitContent ? turns.find((t) => t.role === 'user' && t.text) : undefined;
  const lastAssistant = emitContent ? [...turns].reverse().find((t) => t.role === 'assistant' && t.text) : undefined;

  const rootSpan = {
    traceId,
    spanId: rootId,
    name: `session ${session.title ?? session.session_id}`,
    kind: 1,
    startTimeUnixNano: isoNano(session.started_at),
    endTimeUnixNano: isoNano(session.ended_at ?? session.started_at),
    attributes: [
      attr('session.id', session.session_id),
      attr('gen_ai.conversation.id', session.session_id),
      attr('gen_ai.system', session.agent),
      attr('gen_ai.agent.name', session.agent),
      ...(session.model ? [attr('gen_ai.request.model', session.model)] : []),
      attr('session.turn_count', session.turn_count),
      attr('gen_ai.usage.input_tokens', totals.input),
      attr('gen_ai.usage.output_tokens', totals.output),
      attr('gen_ai.usage.cached_input_tokens', totals.cacheRead),
      attr('code_sessions.cost_usd', Math.round(totals.cost * 1e6) / 1e6),
      ...(session.project_path ? [attr('project.path', session.project_path)] : []),
      ...contentAttrs(
        firstUser ? { role: 'user', text: firstUser.text } : undefined,
        lastAssistant ? { role: 'assistant', text: lastAssistant.text } : undefined,
      ),
      ...attributionAttrs(attribution, {
        'gen_ai.system': session.agent,
        'code_sessions.cost_usd': String(Math.round(totals.cost * 1e6) / 1e6),
      }),
    ],
    status: {},
  };

  const turnSpans = turns.map((t) => {
    const category = turnCategories?.get(t.turn_index);
    return {
      traceId,
      spanId: hexId(`${session.session_id}:${t.turn_index}`, 8),
      parentSpanId: rootId,
      name: `turn ${t.turn_index} ${t.role}`,
      kind: 1,
      startTimeUnixNano: isoNano(t.ts),
      endTimeUnixNano: isoNano(t.ts),
      attributes: [
        attr('turn.index', t.turn_index),
        attr('gen_ai.role', t.role),
        attr('gen_ai.usage.input_tokens', t.usage.input_tokens),
        attr('gen_ai.usage.output_tokens', t.usage.output_tokens),
        attr('code_sessions.tool_count', t.tool_calls.length),
        attr('code_sessions.cost_usd', t.telemetry?.cost_usd ?? 0),
        ...(category ? [attr('code_sessions.turn.category', category)] : []),
        // Optional per-turn content → span input/output (off by default).
        ...(emitContent
          ? contentAttrs(
              t.role === 'assistant' ? undefined : { role: t.role, text: t.text },
              t.role === 'assistant' ? { role: t.role, text: t.text } : undefined,
            )
          : []),
        ...attributionAttrs(attribution, {
          'gen_ai.system': session.agent,
          'code_sessions.cost_usd': String(t.telemetry?.cost_usd ?? 0),
          ...(category ? { 'code_sessions.turn.category': category } : {}),
        }),
      ],
      status: {},
    };
  });

  return {
    resourceSpans: [
      {
        resource: resource(serviceName, session.host),
        scopeSpans: [{ scope: SCOPE, spans: [rootSpan, ...turnSpans] }],
      },
    ],
  };
}

export function buildMetricPayload(
  session: SessionEnvelope,
  turns: Turn[],
  serviceName: string,
  attribution?: Attribution,
): unknown {
  const totals = sumUsage(turns);
  const time = isoNano(session.ended_at ?? session.started_at);
  const base = [
    attr('session.id', session.session_id),
    attr('gen_ai.system', session.agent),
    ...attributionAttrs(attribution),
  ];

  const tokenPoint = (type: string, value: number) => ({
    asInt: value,
    timeUnixNano: time,
    attributes: [...base, attr('gen_ai.token.type', type)],
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
                name: 'code_sessions.tokens',
                unit: '{token}',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    tokenPoint('input', totals.input),
                    tokenPoint('output', totals.output),
                    tokenPoint('cache_read', totals.cacheRead),
                    tokenPoint('cache_write', totals.cacheWrite),
                  ],
                },
              },
              {
                name: 'code_sessions.cost_usd',
                unit: 'USD',
                gauge: {
                  dataPoints: [
                    { asDouble: Math.round(totals.cost * 1e6) / 1e6, timeUnixNano: time, attributes: base },
                  ],
                },
              },
              {
                name: 'code_sessions.turns',
                unit: '{turn}',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [{ asInt: turns.length, timeUnixNano: time, attributes: base }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

export interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * POST an OTLP/HTTP JSON payload; resilient — never throws, returns a result.
 * `signalPath` is the path appended to `endpoint` (default OTLP `/v1/traces` or
 * `/v1/metrics`; override via config for backends that use custom routes).
 * `extraHeaders` carry any auth / tenancy / routing headers the backend needs.
 */
export async function postOtlp(
  endpoint: string,
  signalPath: string,
  payload: unknown,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<PostResult> {
  const url = `${endpoint.replace(/\/$/, '')}${signalPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
