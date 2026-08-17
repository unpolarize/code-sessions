import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { formatSessionUri } from './sessionLink';
import { findSession, listRecent, readTurns, type LocatedSession, type SessionTurnView } from './lookup';

export interface ServeOpts {
  storeDir: string;
  port: number;
  host?: string;
}

export interface ServeHandle {
  url: string;
  close: () => Promise<void>;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(raw);
}

function html(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, inner: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#101418;--panel:#171d24;--card:#1e2630;--line:#2a3440;--fg:#dbe4ee;--dim:#8494a6;--blue:#569cd6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,'Segoe UI',sans-serif}
header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header a{color:var(--blue);text-decoration:none}h1{font-size:16px;margin:0}
main{max-width:860px;margin:0 auto;padding:18px}
.row{display:flex;gap:10px;padding:8px 0;border-bottom:1px dotted var(--line);align-items:baseline}
.row a{color:var(--fg);text-decoration:none}.row a:hover{color:var(--blue)}
.dim{color:var(--dim);font-size:12px}
.btn{display:inline-block;background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:6px 12px;text-decoration:none;margin-right:8px}
.btn.primary{background:var(--blue);color:#08131d;border:0;font-weight:700}
.turn{border-top:1px solid var(--line);padding:10px 0}.role{font-size:11px;letter-spacing:1px;color:var(--dim);font-weight:700}
pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font:inherit}
</style></head><body>${inner}</body></html>`;
}

function indexPage(rows: LocatedSession[]): string {
  const list = rows
    .map((s) => {
      const href = `/s/${encodeURIComponent(s.sessionId)}`;
      return `<div class="row"><a href="${href}">${esc(s.title || s.sessionId)}</a>
        <span class="dim">${esc(s.host)} · ${esc(s.agent)} · ${esc(s.sessionId.slice(0, 8))}</span></div>`;
    })
    .join('');
  return page(
    'Sessions',
    `<header><h1>Sessions</h1><span class="dim">${rows.length} recent</span></header>
     <main>${list || '<p class="dim">No sessions in this store.</p>'}</main>`,
  );
}

function sessionPage(s: LocatedSession, turns: SessionTurnView[]): string {
  const csv = formatSessionUri({ session: s.sessionId, view: 'csv', host: s.host });
  const cb = formatSessionUri({ session: s.sessionId, view: 'cb', host: s.host });
  const body = turns
    .map((t) => {
      const tools = t.tools.length ? `<div class="dim">🔧 ${esc(t.tools.join(', '))}</div>` : '';
      const txt = t.text ? `<pre>${esc(t.text)}</pre>` : '';
      return `<div class="turn"><div class="role">${esc(t.role.toUpperCase())}</div>${txt}${tools}</div>`;
    })
    .join('');
  return page(
    s.title,
    `<header>
       <a href="/">← sessions</a>
       <h1>${esc(s.title)}</h1>
       <span class="dim">${esc(s.host)} · ${esc(s.agent)}</span>
       <a class="btn primary" href="${esc(csv)}">Open in VS Code</a>
       <a class="btn" href="${esc(cb)}">Resume in Code Build</a>
     </header>
     <main>${body || '<p class="dim">empty transcript</p>'}</main>`,
  );
}

export function startServe(opts: ServeOpts): Promise<ServeHandle> {
  const host = opts.host ?? '127.0.0.1';
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${host}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      html(res, 200, indexPage(listRecent(opts.storeDir)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      json(res, 200, { sessions: listRecent(opts.storeDir) });
      return;
    }
    const m = /^\/s\/([^/]+)$/.exec(url.pathname);
    const api = /^\/api\/session\/([^/]+)$/.exec(url.pathname);
    const id = decodeURIComponent((m?.[1] || api?.[1] || '').trim());
    if (req.method === 'GET' && id) {
      const found = findSession(opts.storeDir, id, url.searchParams.get('host') || undefined);
      if (!found) {
        if (api) {
          json(res, 404, { error: `session not found: ${id}` });
        } else {
          html(res, 404, page('Not found', `<header><a href="/">← sessions</a><h1>Session not found</h1></header><main><p class="dim">${esc(id)}</p></main>`));
        }
        return;
      }
      const turns = readTurns(found.dir);
      if (api) {
        json(res, 200, {
          ...found,
          turns,
          open: {
            csv: formatSessionUri({ session: found.sessionId, view: 'csv', host: found.host }),
            cb: formatSessionUri({ session: found.sessionId, view: 'cb', host: found.host }),
          },
        });
        return;
      }
      html(res, 200, sessionPage(found, turns));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        url: `http://${host}:${port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
