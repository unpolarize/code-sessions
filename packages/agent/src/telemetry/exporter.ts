import { existsSync, readFileSync } from 'node:fs';
import { safeParseSession, type SessionEnvelope } from '@unpolarize/code-sessions-schema';
import type { CodeSessionsConfig } from '../config';
import { envelopeFile } from '../store/paths';
import { listSessionDirs } from '../store/scan';
import { readTurns } from '../store/writer';
import { buildMetricPayload, buildTracePayload, postOtlp, type PostResult } from './otlp';

export interface SessionExportResult {
  ok: boolean;
  skipped?: boolean;
  traces?: PostResult;
  metrics?: PostResult;
  reason?: string;
}

function loadEnvelope(sessionDir: string): SessionEnvelope | undefined {
  const path = envelopeFile(sessionDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = safeParseSession(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Export one session's traces + metrics over OTLP/HTTP. Resilient: never throws. */
export async function exportSession(
  cfg: CodeSessionsConfig,
  sessionDir: string,
): Promise<SessionExportResult> {
  if (!cfg.telemetry.enabled) return { ok: false, skipped: true, reason: 'telemetry disabled' };
  const envelope = loadEnvelope(sessionDir);
  if (!envelope) return { ok: false, reason: 'no envelope' };
  const turns = readTurns(sessionDir);
  const { endpoint, serviceName, timeoutMs } = cfg.telemetry;

  const traces = await postOtlp(endpoint, '/v1/traces', buildTracePayload(envelope, turns, serviceName), timeoutMs);
  const metrics = await postOtlp(endpoint, '/v1/metrics', buildMetricPayload(envelope, turns, serviceName), timeoutMs);
  return { ok: traces.ok && metrics.ok, traces, metrics };
}

export interface StoreExportResult {
  total: number;
  exported: number;
  failed: number;
}

/** Export telemetry for every session in the store (backfill path). */
export async function exportStore(
  cfg: CodeSessionsConfig,
  opts: { sinceMonth?: string } = {},
): Promise<StoreExportResult> {
  const refs = listSessionDirs(cfg.storeDir, opts.sinceMonth ? { sinceMonth: opts.sinceMonth } : {});
  let exported = 0;
  let failed = 0;
  for (const ref of refs) {
    const res = await exportSession(cfg, ref.dir);
    if (res.ok) exported++;
    else if (!res.skipped) failed++;
  }
  return { total: refs.length, exported, failed };
}
