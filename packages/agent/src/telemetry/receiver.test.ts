import { describe, expect, it } from 'vitest';
import { extractSessionIds, OtelReceiver } from './receiver';

describe('extractSessionIds', () => {
  it('pulls session ids from OTLP metric data-point attributes', () => {
    const otlp = {
      resourceMetrics: [
        {
          scopeMetrics: [
            { metrics: [{ sum: { dataPoints: [{ attributes: [{ key: 'session.id', value: { stringValue: 'abc' } }] }] } }] },
          ],
        },
      ],
    };
    expect(extractSessionIds(otlp)).toEqual(['abc']);
  });

  it('pulls from OTLP log records, accepts conversation.id, dedups (first-seen order)', () => {
    const otlp = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { attributes: [{ key: 'session.id', value: { stringValue: 'abc' } }] },
                { attributes: [{ key: 'gen_ai.conversation.id', value: { stringValue: 'abc' } }] },
                { attributes: [{ key: 'session.id', value: { stringValue: 'xyz' } }] },
              ],
            },
          ],
        },
      ],
    };
    expect(extractSessionIds(otlp)).toEqual(['abc', 'xyz']);
  });

  it('returns [] for unrelated payloads', () => {
    expect(extractSessionIds({ foo: 1 })).toEqual([]);
    expect(extractSessionIds(null)).toEqual([]);
  });
});

describe('OtelReceiver', () => {
  it('triggers onTrigger with the session ids from a posted OTLP body', async () => {
    const seen: string[] = [];
    const r = new OtelReceiver({ enabled: true, port: 0 }, { onTrigger: (id) => void seen.push(id) });
    const port = await r.start();
    try {
      const body = JSON.stringify({
        resourceMetrics: [
          {
            scopeMetrics: [
              { metrics: [{ sum: { dataPoints: [{ attributes: [{ key: 'session.id', value: { stringValue: 'sess-9' } }] }] } }] },
            ],
          },
        ],
      });
      const res = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(seen).toContain('sess-9');
    } finally {
      await r.stop();
    }
  });
});
