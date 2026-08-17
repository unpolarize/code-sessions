import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDirAsync } from '../test/tmp';
import { startServe, type ServeHandle } from './http';
import { findSession } from './lookup';
import { isSessionId } from './sessionLink';

const SID = '0199bbbb-0000-4000-8000-000000000003';

function seedStore(root: string): string {
  const dir = join(root, 'hosts', 'test-host', '2026-07', SID);
  mkdirSync(join(dir, 'turns'), { recursive: true });
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({
      session_id: SID,
      host: 'test-host',
      agent: 'claude-code',
      project_path: '/repo',
      title: 'Shareable Session Links',
      started_at: '2026-07-22T20:00:00Z',
      turn_count: 1,
      labels: ['file-collab'],
    }),
  );
  writeFileSync(
    join(dir, 'turns', '000001.json'),
    JSON.stringify({
      turn_index: 0,
      ts: '2026-07-22T20:00:00Z',
      role: 'user',
      text: 'hello from file chat',
      tool_calls: [],
    }),
  );
  return root;
}

describe('session serve', () => {
  it('finds a session by UUID and rejects traversal', () => {
    expect(isSessionId('../etc/passwd')).toBe(false);
    return withTempDirAsync(async (root) => {
      seedStore(root);
      const found = findSession(root, SID);
      expect(found?.title).toBe('Shareable Session Links');
      expect(found?.host).toBe('test-host');
      expect(findSession(root, 'not-a-uuid')).toBeNull();
    });
  });

  it('serves HTML with vscode:// deep links and JSON API', async () => {
    await withTempDirAsync(async (root) => {
      seedStore(root);
      const handle: ServeHandle = await startServe({ storeDir: root, port: 0, host: '127.0.0.1' });
      try {
        const index = await (await fetch(handle.url + '/')).text();
        expect(index).toContain('Shareable Session Links');
        const page = await (await fetch(`${handle.url}/s/${SID}`)).text();
        expect(page).toContain('vscode://zhirafovod.code-sessions/open?session=');
        expect(page).toContain('view=cb');
        expect(page).toContain('Open in VS Code');
        const api = (await (await fetch(`${handle.url}/api/session/${SID}`)).json()) as {
          title: string;
          open: { csv: string; cb: string };
          turns: Array<{ text: string }>;
        };
        expect(api.title).toBe('Shareable Session Links');
        expect(api.turns[0]?.text).toBe('hello from file chat');
        expect(api.open.csv).toContain(SID);
        const missing = await fetch(`${handle.url}/s/4ba90b1a-6188-4702-9476-402fcb37c3af`);
        expect(missing.status).toBe(404);
      } finally {
        await handle.close();
      }
    });
  });
});
