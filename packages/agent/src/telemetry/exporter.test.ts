import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Turn } from '@unpolarize/code-sessions-schema';
import { rebuildEnvelope, writeTurnFile } from '../store/writer';
import { sessionDir } from '../store/paths';
import { makeConfig, withTempDirAsync } from '../test/tmp';
import { exportSession, exportStore } from './exporter';

function turn(i: number, over: Partial<Turn> = {}): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 's1',
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: `2026-06-20T08:0${i}:00Z`,
    role: 'assistant',
    text: '',
    tool_calls: [],
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

function seed(store: string): string {
  const dir = sessionDir(store, 'h', '2026-06', 's1');
  writeTurnFile(dir, turn(0, { role: 'user', text: 'hi' }));
  writeTurnFile(dir, turn(1, { telemetry: { cost_usd: 0.3 } }));
  rebuildEnvelope(store, 'h', '2026-06', 's1', { model: 'claude-opus-4-8' }, {
    session_id: 's1',
    host: 'h',
    agent: 'claude-code',
    native_uuid: 's1',
  });
  return dir;
}

async function withCollector<T>(fn: (endpoint: string, paths: string[]) => Promise<T>): Promise<T> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      paths.push(req.url ?? '');
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, paths);
  } finally {
    await new Promise<void>((r) => (server as Server).close(() => r()));
  }
}

describe('exportSession', () => {
  it('ships traces + metrics to the collector', async () => {
    await withTempDirAsync(async (store) => {
      const dir = seed(store);
      await withCollector(async (endpoint, paths) => {
        const cfg = makeConfig(store, { telemetry: { enabled: true, endpoint } });
        const res = await exportSession(cfg, dir);
        expect(res.ok).toBe(true);
        expect(paths.sort()).toEqual(['/v1/metrics', '/v1/traces']);
      });
    });
  });

  it('skips when telemetry is disabled', async () => {
    await withTempDirAsync(async (store) => {
      const dir = seed(store);
      const res = await exportSession(makeConfig(store, { telemetry: { enabled: false } }), dir);
      expect(res.skipped).toBe(true);
    });
  });

  it('is resilient when the collector is down', async () => {
    await withTempDirAsync(async (store) => {
      const dir = seed(store);
      const cfg = makeConfig(store, { telemetry: { enabled: true, endpoint: 'http://127.0.0.1:9', timeoutMs: 400 } });
      const res = await exportSession(cfg, dir);
      expect(res.ok).toBe(false); // failed but did not throw
    });
  });
});

describe('exportStore', () => {
  it('exports every session', async () => {
    await withTempDirAsync(async (store) => {
      seed(store);
      await withCollector(async (endpoint) => {
        const cfg = makeConfig(store, { telemetry: { enabled: true, endpoint } });
        const res = await exportStore(cfg);
        expect(res.total).toBe(1);
        expect(res.exported).toBe(1);
        expect(res.failed).toBe(0);
      });
    });
  });
});
