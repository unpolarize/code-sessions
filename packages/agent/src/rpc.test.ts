import { describe, expect, it } from 'vitest';
import { Daemon } from './daemon';
import { rpcCall } from './rpc';
import { sendEvent } from './ipc';
import { makeConfig, withTempDirAsync } from './test/tmp';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_PROTOCOL } from '@unpolarize/code-sessions-schema';

describe('daemon JSON-RPC (phase 1)', () => {
  it('hello, create, list{cwd}, append, replay, metrics; hooks still ack', async () => {
    await withTempDirAsync(async (root) => {
      const store = join(root, 'store');
      const socketPath = join(root, 'd.sock');
      const d = new Daemon(makeConfig(store, { socketPath, batch: { maxTurns: 99 } }));
      await d.start();
      try {
        const hello = (await rpcCall(socketPath, 'hello')) as { protocol: number; daemonVersion: string };
        expect(hello.protocol).toBe(DAEMON_PROTOCOL);
        expect(hello.daemonVersion).toBeTruthy();

        const a = (await rpcCall(socketPath, 'session.create', {
          backend: 'grok',
          cwd: '/proj-a',
          title: 'A',
        })) as { id: string };
        const b = (await rpcCall(socketPath, 'session.create', {
          backend: 'grok',
          cwd: '/proj-b',
          title: 'B',
        })) as { id: string };
        expect(a.id).not.toBe(b.id);

        const listed = (await rpcCall(socketPath, 'session.list', {
          filter: { cwd: '/proj-a' },
        })) as { sessions: Array<{ id: string; cwd: string }> };
        expect(listed.sessions.map((s) => s.id)).toEqual([a.id]);
        expect(listed.sessions[0]?.cwd).toBe('/proj-a');

        await rpcCall(socketPath, 'session.append', {
          id: a.id,
          event: { kind: 'user', text: 'hi' },
          ts: 1,
        });
        const replay = (await rpcCall(socketPath, 'session.replay', { id: a.id, fromSeq: 0 })) as {
          events: Array<{ seq: number }>;
          nextSeq: number;
        };
        expect(replay.events).toHaveLength(1);
        expect(replay.nextSeq).toBe(2);

        const metrics = (await rpcCall(socketPath, 'metrics')) as { eventLoopLagMs: { p50: number } };
        expect(typeof metrics.eventLoopLagMs.p50).toBe('number');

        // hook clients must still get a fast ack, not an RPC error
        mkdirSync(join(root, 'src'), { recursive: true });
        const transcript = join(root, 'src', 'sess-hook.jsonl');
        writeFileSync(
          transcript,
          '{"type":"user","sessionId":"sess-hook","cwd":"/proj","timestamp":"2026-06-20T08:00:00Z","message":{"role":"user","content":"hi"}}\n',
        );
        const ack = await sendEvent(socketPath, {
          event: 'PostToolUse',
          session_id: 'sess-hook',
          transcript_path: transcript,
        });
        expect(ack.ok).toBe(true);
        expect(existsSync(socketPath)).toBe(true);
      } finally {
        await d.stop();
      }
    });
  });
});
