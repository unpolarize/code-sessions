import { z } from 'zod';

/**
 * Canonical, agent-neutral session record schemas.
 *
 * Every record carries a versioned `schema` tag so consumers can migrate the
 * way the SQLite `user_version` pattern does. Native records are adapted INTO
 * these shapes while the verbatim `raw` event is preserved for lossless resume.
 */

export const AGENTS = ['claude-code', 'codex', 'grok', 'unknown'] as const;
export const ROLES = ['user', 'assistant', 'tool', 'system'] as const;

export const UsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
    cache_read_tokens: z.number().int().nonnegative().default(0),
    cache_write_tokens: z.number().int().nonnegative().default(0),
  })
  .strict();

export const ToolCallSchema = z
  .object({
    name: z.string(),
    input: z.unknown().optional(),
    id: z.string().optional(),
  })
  .strict();

export const TelemetrySchema = z
  .object({
    latency_ms: z.number().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(),
  })
  .strict();

/** Immutable, write-once per-turn record: turns/NNNNNN.json */
export const TurnSchema = z
  .object({
    schema: z.literal('session-store/turn@1'),
    session_id: z.string().min(1),
    host: z.string().min(1),
    agent: z.enum(AGENTS),
    turn_index: z.number().int().nonnegative(),
    ts: z.string().min(1),
    role: z.enum(ROLES),
    text: z.string().default(''),
    tool_calls: z.array(ToolCallSchema).default([]),
    usage: UsageSchema.default({}),
    telemetry: TelemetrySchema.optional(),
    /** true when secret-scrubbing redacted content in this turn */
    scrubbed: z.boolean().default(false),
    /** sha256 pointer when a large tool output was externalized to raw/ */
    raw_ref: z.string().nullable().default(null),
    /** verbatim native event for lossless tier-1 resume */
    raw: z.unknown().optional(),
  })
  .strict();

export const TotalsSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
    cost_usd: z.number().nonnegative().default(0),
  })
  .strict();

export const NativeRefSchema = z
  .object({
    format: z.string(),
    uuid: z.string(),
  })
  .strict();

/** Derived, rebuildable aggregate: session.json */
export const SessionSchema = z
  .object({
    schema: z.literal('session-store/session@1'),
    session_id: z.string().min(1),
    host: z.string().min(1),
    agent: z.enum(AGENTS),
    project_path: z.string().default(''),
    git_branch: z.string().optional(),
    model: z.string().optional(),
    started_at: z.string().optional(),
    ended_at: z.string().optional(),
    turn_count: z.number().int().nonnegative().default(0),
    tool_call_count: z.number().int().nonnegative().default(0),
    totals: TotalsSchema.default({}),
    title: z.string().optional(),
    labels: z.array(z.string()).default([]),
    native_ref: NativeRefSchema,
  })
  .strict();

export const SIGNAL_KINDS = [
  'stuck-loop',
  'error-recovery',
  'high-cost-turn',
  'long-session',
  'affect-negative',
  'affect-positive',
  'tool-heavy',
  'other',
] as const;

export const SignalSchema = z
  .object({
    kind: z.enum(SIGNAL_KINDS),
    severity: z.enum(['info', 'warn', 'critical']).default('info'),
    turn_index: z.number().int().nonnegative().optional(),
    note: z.string().optional(),
  })
  .strict();

/** Derived insights: insights/labels.json (MVP-1.1) */
export const InsightsSchema = z
  .object({
    schema: z.literal('session-store/insights@1'),
    session_id: z.string().min(1),
    host: z.string().min(1),
    generated_at: z.string(),
    provider: z.string(),
    topic: z.string().optional(),
    tags: z.array(z.string()).default([]),
    signals: z.array(SignalSchema).default([]),
    summary: z.string().optional(),
  })
  .strict();

export type Usage = z.infer<typeof UsageSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type Telemetry = z.infer<typeof TelemetrySchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type Totals = z.infer<typeof TotalsSchema>;
export type SessionEnvelope = z.infer<typeof SessionSchema>;
export type Signal = z.infer<typeof SignalSchema>;
export type Insights = z.infer<typeof InsightsSchema>;
export type AgentKind = (typeof AGENTS)[number];
export type Role = (typeof ROLES)[number];
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SCHEMA_VERSIONS = {
  turn: 'session-store/turn@1',
  session: 'session-store/session@1',
  insights: 'session-store/insights@1',
} as const;
