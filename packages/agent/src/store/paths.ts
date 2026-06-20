import { join } from 'node:path';

/**
 * Store layout — sharded host/month/session so no directory holds too many
 * entries and retention is a `rm -rf <old-month>`.
 *
 *   hosts/<host>/<YYYY-MM>/<session-uuid>/
 *     session.json
 *     turns/000007.json
 *     telemetry/otel.jsonl
 *     insights/labels.json
 *     raw/<sha256>
 */

export function monthOf(ts: string | undefined): string {
  if (ts) {
    const m = /^(\d{4})-(\d{2})/.exec(ts);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return 'unknown';
}

export function sessionDir(storeDir: string, host: string, month: string, sessionId: string): string {
  return join(storeDir, 'hosts', host, month, sessionId);
}

export function turnFile(dir: string, index: number): string {
  return join(dir, 'turns', `${String(index).padStart(6, '0')}.json`);
}

export function envelopeFile(dir: string): string {
  return join(dir, 'session.json');
}

export function insightsFile(dir: string): string {
  return join(dir, 'insights', 'labels.json');
}

export function telemetryFile(dir: string): string {
  return join(dir, 'telemetry', 'otel.jsonl');
}

export function rawBlobFile(dir: string, sha: string): string {
  return join(dir, 'raw', sha);
}
