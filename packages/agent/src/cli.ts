import { loadConfig } from './config';
import { HELP, overridesFromFlags, parseFlags } from './cliargs';
import {
  cmdBackfill,
  cmdDoctor,
  cmdExport,
  cmdFork,
  cmdGraph,
  cmdIndex,
  cmdInit,
  cmdInstallHooks,
  cmdInstallSkills,
  cmdQuery,
  cmdReindex,
  cmdSearch,
  cmdStatus,
  cmdUsage,
  startDaemon,
  startServe,
  type CommandResult,
} from './commands';
import { cmdAnalytics } from './analytics/command';
import { handleHookInput, readStdin } from './hooks/shim';
import { flushTrace, initTrace, startFileSink, startSpan, startStderrSlowSink } from './hostTrace';

async function emit(res: CommandResult): Promise<never> {
  await flushTrace();
  if (res.output) process.stdout.write(`${res.output}\n`);
  process.exit(res.code);
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? 'help';
  initTrace('cs', '0.13.2');
  startFileSink();
  startStderrSlowSink();
  const span = startSpan(`cs.cli.${command}`);
  const flags = parseFlags(argv.slice(1));
  const cfg = loadConfig(overridesFromFlags(flags));

  switch (command) {
    case 'init':
      await emit(cmdInit(cfg));
      break;
    case 'status':
      await emit(cmdStatus(cfg));
      break;
    case 'doctor':
      await emit(cmdDoctor(cfg));
      break;
    case 'install-hooks':
      await emit(
        cmdInstallHooks(cfg, {
          ...(typeof flags.settings === 'string' ? { settingsPath: flags.settings } : {}),
          ...(typeof flags.command === 'string' ? { command: flags.command } : {}),
          ...(flags.agent === 'grok' ? { agent: 'grok' as const } : {}),
          ...(flags.agent === 'codex' ? { agent: 'codex' as const } : {}),
        }),
      );
      break;
    case 'install-skills':
      await emit(cmdInstallSkills(typeof flags.agent === 'string' ? { agent: flags.agent as 'claude' | 'codex' | 'grok' | 'all' } : {}));
      break;
    case 'backfill':
      await emit(
        await cmdBackfill(cfg, {
          ...(typeof flags.projects === 'string' ? { projectsDir: flags.projects } : {}),
          ...(typeof flags.agent === 'string' ? { agent: flags.agent as 'claude' | 'grok' | 'codex' | 'codebuild' | 'all' } : {}),
        }),
      );
      break;
    case 'reindex':
      await emit(await cmdReindex(cfg, typeof flags.since === 'string' ? { since: flags.since } : {}));
      break;
    case 'analytics':
      await emit(await cmdAnalytics(cfg));
      break;
    case 'export':
      await emit(await cmdExport(cfg, typeof flags.since === 'string' ? { since: flags.since } : {}));
      break;
    case 'index':
      await emit(cmdIndex(cfg));
      break;
    case 'usage':
      await emit(cmdUsage(cfg, { json: flags.json === true }));
      break;
    case 'graph':
      await emit(cmdGraph(cfg, { json: flags.json === true }));
      break;
    case 'query':
      await emit(
        cmdQuery(cfg, {
          ...(typeof flags.limit === 'string' ? { limit: Number(flags.limit) } : {}),
          ...(typeof flags.agent === 'string' ? { agent: flags.agent } : {}),
        }),
      );
      break;
    case 'search': {
      const q = argv.slice(1).find((a) => !a.startsWith('--')) ?? '';
      await emit(cmdSearch(cfg, { query: q, ...(typeof flags.limit === 'string' ? { limit: Number(flags.limit) } : {}) }));
      break;
    }
    case 'fork': {
      const sid = argv.slice(1).find((a) => !a.startsWith('--')) ?? '';
      await emit(
        cmdFork(cfg, {
          sessionId: sid,
          atTurn: typeof flags.at === 'string' ? Number(flags.at) : NaN,
          ...(typeof flags.id === 'string' ? { newId: flags.id } : {}),
        }),
      );
      break;
    }
    case 'hook': {
      // Never fail the agent: swallow everything, always exit 0.
      try {
        const input = await readStdin();
        await handleHookInput(cfg.socketPath, input);
      } catch {
        /* ignore */
      }
      span.end();
      await flushTrace();
      process.exit(0);
      break;
    }
    case 'start': {
      const daemon = await startDaemon(cfg);
      span.end();
      await flushTrace();
      process.stdout.write(`code-sessions daemon listening on ${cfg.socketPath}\n`);
      const stop = async (): Promise<void> => {
        await daemon.stop();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      break; // keep the event loop alive
    }
    case 'serve': {
      const port = typeof flags.port === 'string' ? Number(flags.port) : 8787;
      const bind = typeof flags.bind === 'string' ? flags.bind : '127.0.0.1';
      const handle = await startServe({ storeDir: cfg.storeDir, port, host: bind });
      process.stdout.write(`code-sessions serve ${handle.url}  (store ${cfg.storeDir})\n`);
      const stop = async (): Promise<void> => {
        await handle.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      break;
    }
    case 'help':
    case '--help':
    case undefined:
      process.stdout.write(HELP);
      span.end();
      await flushTrace();
      process.exit(command ? 0 : 1);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      span.end();
      await flushTrace();
      process.exit(1);
  }
  span.end();
}

main(process.argv.slice(2)).catch(async (err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  await flushTrace();
  process.exit(1);
});
