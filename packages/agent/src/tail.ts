import { existsSync, readFileSync } from 'node:fs';

export interface TailResult {
  /** parsed JSON objects for each complete new line */
  records: unknown[];
  /** raw text of each complete new line (parse failures still advance offset) */
  rawLines: string[];
  /** new byte offset to persist (only advances past complete, newline-terminated lines) */
  newOffset: number;
  /** number of lines that failed to JSON.parse */
  parseErrors: number;
}

/**
 * Read newly-appended complete lines from a JSONL file starting at a byte
 * offset. A trailing partial line (no terminating newline) is left unconsumed
 * so the next read picks it up once it's complete.
 */
export function readNewLines(filePath: string, fromOffset: number): TailResult {
  const empty: TailResult = { records: [], rawLines: [], newOffset: fromOffset, parseErrors: 0 };
  if (!existsSync(filePath)) return empty;

  const buf = readFileSync(filePath);
  if (fromOffset >= buf.length) return { ...empty, newOffset: buf.length };

  const slice = buf.subarray(fromOffset);
  const lastNewline = slice.lastIndexOf(0x0a); // '\n'
  if (lastNewline < 0) return empty; // no complete line yet

  const complete = slice.subarray(0, lastNewline + 1).toString('utf8');
  const consumedBytes = Buffer.byteLength(complete, 'utf8');

  const records: unknown[] = [];
  const rawLines: string[] = [];
  let parseErrors = 0;
  for (const line of complete.split('\n')) {
    if (line.trim().length === 0) continue;
    rawLines.push(line);
    try {
      records.push(JSON.parse(line));
    } catch {
      parseErrors++;
    }
  }

  return { records, rawLines, newOffset: fromOffset + consumedBytes, parseErrors };
}
