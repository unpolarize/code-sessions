import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readNewLines } from './tail';
import { withTempDir } from './test/tmp';

describe('readNewLines', () => {
  it('returns empty for a missing file', () => {
    const r = readNewLines('/no/such/file.jsonl', 0);
    expect(r.records).toEqual([]);
    expect(r.newOffset).toBe(0);
  });

  it('reads complete lines and advances the offset', () => {
    withTempDir((dir) => {
      const f = join(dir, 's.jsonl');
      writeFileSync(f, '{"a":1}\n{"b":2}\n');
      const r = readNewLines(f, 0);
      expect(r.records).toEqual([{ a: 1 }, { b: 2 }]);
      expect(r.newOffset).toBe(16);
      // re-read from new offset yields nothing
      expect(readNewLines(f, r.newOffset).records).toEqual([]);
    });
  });

  it('does not consume a trailing partial line', () => {
    withTempDir((dir) => {
      const f = join(dir, 's.jsonl');
      writeFileSync(f, '{"a":1}\n{"b":2'); // second line incomplete
      const r = readNewLines(f, 0);
      expect(r.records).toEqual([{ a: 1 }]);
      expect(r.newOffset).toBe(8);
      // complete the line; next read picks it up
      appendFileSync(f, '}\n');
      const r2 = readNewLines(f, r.newOffset);
      expect(r2.records).toEqual([{ b: 2 }]);
    });
  });

  it('counts parse errors but still advances', () => {
    withTempDir((dir) => {
      const f = join(dir, 's.jsonl');
      writeFileSync(f, 'not json\n{"ok":1}\n');
      const r = readNewLines(f, 0);
      expect(r.parseErrors).toBe(1);
      expect(r.records).toEqual([{ ok: 1 }]);
      expect(r.newOffset).toBe(18);
    });
  });
});
