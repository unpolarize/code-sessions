#!/usr/bin/env node
// Launcher: prefer the built dist; in a dev checkout, run the TS entry via tsx.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const distCli = join(here, '..', 'dist', 'cli.js');

if (existsSync(distCli)) {
  await import(distCli);
} else {
  // Dev mode: spawn node with tsx's loader (Node >=20.6 uses --import, not --loader).
  const tsCli = join(here, '..', 'src', 'cli.ts');
  const res = spawnSync(process.execPath, ['--import', 'tsx', tsCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(res.status ?? 1);
}
