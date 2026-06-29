import { createServer, type Server } from 'node:http';

/**
 * A minimal OTLP/HTTP receiver the daemon runs so a coding agent's *own*
 * telemetry can drive capture. Claude Code (`CLAUDE_CODE_ENABLE_TELEMETRY=1`)
 * and Codex export OTLP metrics/logs carrying a `session.id`; we treat an
 * inbound export as a **trigger** — "this session just did something" — and hand
 * the id to the daemon, which reads the transcript and (re)emits the GenAI-semconv
 * turn-traces. The OTLP payload itself is not trusted as the span source; the
 * transcript is. Grok (no OTel) keeps the file-watch trigger.
 */

export interface OtelTriggerConfig {
  enabled: boolean;
  /** TCP port to listen on (the endpoint you point the agent's OTLP exporter at). 0 = ephemeral. */
  port: number;
  /** bind host; defaults to loopback so the receiver is never exposed off-box */
  host?: string;
}

export interface OtelReceiverDeps {
  /** invoked (deduped per request) with each session id seen in an inbound export */
  onTrigger: (sessionId: string) => void | Promise<void>;
}

const SESSION_KEYS = new Set(['session.id', 'gen_ai.conversation.id', 'conversation.id']);

/**
 * Deep-scan an OTLP/HTTP JSON payload (metrics, logs, or traces) for the session
 * id carried in `{key, value:{stringValue}}` attribute pairs. First-seen order,
 * deduped. Works across signals because OTLP nests attributes the same way.
 */
export function extractSessionIds(payload: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node && typeof node === 'object') {
      const o = node as { key?: unknown; value?: { stringValue?: unknown } };
      if (typeof o.key === 'string' && SESSION_KEYS.has(o.key) && typeof o.value?.stringValue === 'string') {
        const v = o.value.stringValue;
        if (!seen.has(v)) {
          seen.add(v);
          out.push(v);
        }
      }
      for (const k of Object.keys(node as Record<string, unknown>)) walk((node as Record<string, unknown>)[k]);
    }
  };
  walk(payload);
  return out;
}

export class OtelReceiver {
  private server?: Server;

  constructor(
    private readonly cfg: OtelTriggerConfig,
    private readonly deps: OtelReceiverDeps,
  ) {}

  /** Start listening. Resolves with the bound port (useful when cfg.port is 0). */
  start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.onRequest(req, res));
      server.on('error', reject);
      server.listen(this.cfg.port, this.cfg.host ?? '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.cfg.port);
      });
      this.server = server;
    });
  }

  private onRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        for (const id of extractSessionIds(JSON.parse(body))) await this.deps.onTrigger(id);
      } catch {
        /* malformed export — ignore, still 200 so the agent's exporter doesn't back off */
      }
      if (!res.writableEnded) res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    req.on('error', () => {
      /* client hangup — ignore */
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
  }
}
