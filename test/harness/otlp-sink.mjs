/**
 * Tiny OTLP/HTTP JSON sink: writes every received export to a file so a capture
 * run can keep the agents' *real* OTel emissions. One line per POST, per signal.
 *
 *   SINK_OUT=./cap SINK_PORT=4318 node test/harness/otlp-sink.mjs
 *
 * Point a coding agent at it, e.g. for Claude Code:
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp \
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
 */
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.SINK_OUT || './otel-capture';
const PORT = Number(process.env.SINK_PORT || 4318);
mkdirSync(OUT, { recursive: true });

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const sig = (req.url || 'root').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
    try {
      appendFileSync(join(OUT, `${sig}.jsonl`), `${body.replace(/\s*\n\s*/g, ' ')}\n`);
    } catch {
      /* best effort */
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  req.on('error', () => {});
});
server.listen(PORT, '127.0.0.1', () => console.log(`otlp-sink :${PORT} → ${OUT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
