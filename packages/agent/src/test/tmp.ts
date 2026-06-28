import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, resolveConfig, type CodeSessionsConfig, type DeepPartial } from '../config';

/** Create a throwaway temp dir, run fn, always clean up. */
export function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cs-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Async variant: awaits fn before cleaning up the temp dir. */
export async function withTempDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'cs-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function makeConfig(
  storeDir: string,
  override: DeepPartial<CodeSessionsConfig> = {},
): CodeSessionsConfig {
  // telemetry off + source watching off by default in tests, so we never hit a real
  // collector and never scan the real ~/.codex / ~/.grok dirs from a temp-store test.
  const base = resolveConfig(defaultConfig('/home/test', 'test-host'), {
    storeDir,
    telemetry: { enabled: false },
    capture: { watch: { codex: false, grok: false } },
  });
  return resolveConfig(base, override);
}
