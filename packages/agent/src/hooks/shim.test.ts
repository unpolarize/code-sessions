import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Daemon } from '../daemon';
import { makeConfig, withTempDirAsync } from '../test/tmp';
import { handleHookInput } from './shim';

const LINE =
  '{"type":"user","sessionId":"sess-1","timestamp":"2026-06-20T08:00:00Z","message":{"role":"user","content":"hi"}}';

describe('handleHookInput', () => {
  it('is a silent no-op when the daemon is not running', async () => {
    const ack = await handleHookInput('/no/such/daemon.sock', JSON.stringify({ event: 'Stop', session_id: 's' }));
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/not running/);
  });

  it('forwards a valid hook payload to a running daemon', async () => {
    await withTempDirAsync(async (root) => {
      const store = join(root, 'store');
      const src = join(root, 'src');
      mkdirSync(src, { recursive: true });
      const transcript = join(src, 'sess-1.jsonl');
      writeFileSync(transcript, `${LINE}\n`);
      const socketPath = join(root, 'd.sock');
      const d = new Daemon(makeConfig(store, { socketPath, batch: { maxTurns: 1 } }));
      await d.start();
      try {
        const payload = JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: 'sess-1',
          transcript_path: transcript,
        });
        const ack = await handleHookInput(socketPath, payload);
        expect(ack.ok).toBe(true);
        expect(ack.newTurns).toBe(1);
      } finally {
        await d.stop();
      }
    });
  });

  it('rejects malformed JSON once a daemon socket exists', async () => {
    await withTempDirAsync(async (root) => {
      const socketPath = join(root, 'd.sock');
      const d = new Daemon(makeConfig(join(root, 'store'), { socketPath }));
      await d.start();
      try {
        const ack = await handleHookInput(socketPath, 'not json');
        expect(ack.ok).toBe(false);
        expect(ack.error).toMatch(/invalid hook json/);
      } finally {
        await d.stop();
      }
    });
  });
});
