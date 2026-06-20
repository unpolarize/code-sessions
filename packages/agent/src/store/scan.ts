import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

export interface SessionRef {
  host: string;
  month: string;
  sessionId: string;
  dir: string;
}

/** readdir(withFileTypes) that never throws and returns [] for a missing dir. */
export function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }
}

function subdirs(dir: string): string[] {
  return readEntries(dir)
    .filter((e) => e.isDirectory())
    .map((e) => String(e.name));
}

/** Enumerate every session in the store: hosts/<host>/<month>/<sessionId>/. */
export function listSessionDirs(storeDir: string, opts: { sinceMonth?: string } = {}): SessionRef[] {
  const hostsRoot = join(storeDir, 'hosts');
  const out: SessionRef[] = [];
  for (const host of subdirs(hostsRoot)) {
    for (const month of subdirs(join(hostsRoot, host))) {
      if (opts.sinceMonth && month < opts.sinceMonth) continue;
      for (const sessionId of subdirs(join(hostsRoot, host, month))) {
        out.push({ host, month, sessionId, dir: join(hostsRoot, host, month, sessionId) });
      }
    }
  }
  return out;
}
