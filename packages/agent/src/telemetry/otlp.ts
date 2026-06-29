import { createHash } from 'node:crypto';

/**
 * Low-level OTLP/HTTP JSON primitives shared by the telemetry builders: attribute
 * helpers, attribution mapping, deterministic ids, the OTel resource/scope, and a
 * dependency-free `postOtlp`. The GenAI-semconv span/metric model lives in
 * `genai.ts`; this module is the wire plumbing it builds on.
 */

type AnyValue =
  | { stringValue: string }
  | { intValue: number }
  | { doubleValue: number }
  | { boolValue: boolean };

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export function attr(key: string, value: string | number | boolean): KeyValue {
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
  /** custom association properties, emitted verbatim under their own keys */
  custom?: Record<string, string>;
}

/** Flat attribution map (semconv keys → value) used for both span attributes and a
 * single JSON `metadata` attribute (some backends fold it into one groupable column). */
export function attributionMap(a: Attribution): Record<string, string> {
  const m: Record<string, string> = {};
  if (a.intent) m['gen_ai.conversation.intent'] = a.intent;
  if (a.topic) m['gen_ai.conversation.topic'] = a.topic;
  if (a.repo) m['code.repository'] = a.repo;
  if (a.repoUrl) m['vcs.repository.url'] = a.repoUrl;
  if (a.enduser) m['enduser.id'] = a.enduser;
  for (const [k, v] of Object.entries(a.custom ?? {})) {
    if (k && typeof v === 'string' && v.length > 0) m[k] = v;
  }
  return m;
}


export function hexId(input: string, bytes: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, bytes * 2);
}

/** Max characters of turn text emitted as span content (keeps spans small). */
const MAX_CONTENT_CHARS = 8000;

/** Truncate content for span input/output, marking elision. */
export function capContent(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_CONTENT_CHARS)}… [truncated ${text.length - MAX_CONTENT_CHARS} chars]`;
}


/** ISO-8601 → unix nanoseconds as a string (avoids float precision loss). */
export function isoNano(ts: string | undefined): string {
  if (!ts) return '0';
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? '0' : `${ms}000000`;
}

export const SCOPE = { name: 'code-sessions', version: '0.1.0' };

export function resource(serviceName: string, host: string): { attributes: KeyValue[] } {
  return {
    attributes: [
      attr('service.name', serviceName),
      attr('host.name', host),
      attr('telemetry.sdk.name', 'code-sessions'),
      attr('telemetry.sdk.language', 'nodejs'),
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
