import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { attributionMap, hexId, isoNano, postOtlp, type Attribution } from './otlp';

describe('isoNano', () => {
  it('converts ISO timestamps to unix nanoseconds', () => {
    expect(isoNano('2026-06-20T08:00:00Z')).toBe(`${Date.parse('2026-06-20T08:00:00Z')}000000`);
    expect(isoNano(undefined)).toBe('0');
    expect(isoNano('not-a-date')).toBe('0');
  });
});

describe('hexId', () => {
  it('is deterministic and the requested byte length', () => {
    expect(hexId('a:0', 16)).toMatch(/^[0-9a-f]{32}$/);
    expect(hexId('a:0', 8)).toMatch(/^[0-9a-f]{16}$/);
    expect(hexId('a:0', 8)).toBe(hexId('a:0', 8));
    expect(hexId('a:0', 8)).not.toBe(hexId('a:1', 8));
  });
});

describe('attributionMap', () => {
  it('maps derived + custom attribution onto semconv keys (omitting absent)', () => {
    const a: Attribution = {
      enduser: 'a@x.com',
      repo: 'acme/app',
      repoUrl: 'git@github.com:acme/app.git',
      intent: 'feature',
      topic: 'otel',
      custom: { 'cost.center': 'cc-1' },
    };
    expect(attributionMap(a)).toEqual({
      'enduser.id': 'a@x.com',
      'code.repository': 'acme/app',
      'vcs.repository.url': 'git@github.com:acme/app.git',
      'gen_ai.conversation.intent': 'feature',
      'gen_ai.conversation.topic': 'otel',
      'cost.center': 'cc-1',
    });
    expect(attributionMap({})).toEqual({});
  });
});

describe('postOtlp', () => {
  it('posts JSON to the collector and reports success', async () => {
    const received: { path: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await postOtlp(`http://127.0.0.1:${port}`, '/v1/traces', { hello: 1 }, 2000);
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(received[0]!.path).toBe('/v1/traces');
      expect(JSON.parse(received[0]!.body)).toEqual({ hello: 1 });
    } finally {
      await new Promise<void>((r) => (server as Server).close(() => r()));
    }
  });

  it('is resilient when the collector is unreachable (no throw)', async () => {
    const res = await postOtlp('http://127.0.0.1:9', '/v1/metrics', {}, 500);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
