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
  type CommandResult,
} from './commands';
import { cmdAnalytics } from './analytics/command';
import { handleHookInput, readStdin } from './hooks/shim';

function emit(res: CommandResult): never {
  if (res.output) process.stdout.write(`${res.output}\n`);
  process.exit(res.code);
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  const flags = parseFlags(argv.slice(1));
  const cfg = loadConfig(overridesFromFlags(flags));

  switch (command) {
    case 'init':
      emit(cmdInit(cfg));
      break;
    case 'status':
      emit(cmdStatus(cfg));
      break;
    case 'doctor':
      emit(cmdDoctor(cfg));
      break;
    case 'install-hooks':
      emit(
        cmdInstallHooks(cfg, {
          ...(typeof flags.settings === 'string' ? { settingsPath: flags.settings } : {}),
          ...(typeof flags.command === 'string' ? { command: flags.command } : {}),
        }),
      );
      break;
    case 'install-skills':
      emit(cmdInstallSkills(typeof flags.agent === 'string' ? { agent: flags.agent as 'claude' | 'codex' | 'grok' | 'all' } : {}));
      break;
    case 'backfill':
      emit(
        await cmdBackfill(cfg, {
          ...(typeof flags.projects === 'string' ? { projectsDir: flags.projects } : {}),
          ...(typeof flags.agent === 'string' ? { agent: flags.agent as 'claude' | 'grok' | 'codex' | 'codebuild' | 'all' } : {}),
        }),
      );
      break;
    case 'reindex':
      emit(await cmdReindex(cfg, typeof flags.since === 'string' ? { since: flags.since } : {}));
      break;
    case 'analytics':
      emit(await cmdAnalytics(cfg));
      break;
    case 'export':
      emit(await cmdExport(cfg, typeof flags.since === 'string' ? { since: flags.since } : {}));
      break;
    case 'index':
      emit(cmdIndex(cfg));
      break;
    case 'usage':
      emit(cmdUsage(cfg, { json: flags.json === true }));
      break;
    case 'graph':
      emit(cmdGraph(cfg, { json: flags.json === true }));
      break;
    case 'query':
      emit(
        cmdQuery(cfg, {
          ...(typeof flags.limit === 'string' ? { limit: Number(flags.limit) } : {}),
          ...(typeof flags.agent === 'string' ? { agent: flags.agent } : {}),
        }),
      );
      break;
    case 'search': {
      const q = argv.slice(1).find((a) => !a.startsWith('--')) ?? '';
      emit(cmdSearch(cfg, { query: q, ...(typeof flags.limit === 'string' ? { limit: Number(flags.limit) } : {}) }));
      break;
    }
    case 'fork': {
      const sid = argv.slice(1).find((a) => !a.startsWith('--')) ?? '';
      emit(
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
      process.exit(0);
      break;
    }
    case 'start': {
      const daemon = await startDaemon(cfg);
      process.stdout.write(`code-sessions daemon listening on ${cfg.socketPath}\n`);
      const stop = async (): Promise<void> => {
        await daemon.stop();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      break; // keep the event loop alive
    }
    case 'help':
    case '--help':
    case undefined:
      process.stdout.write(HELP);
      process.exit(command ? 0 : 1);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exit(1);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
