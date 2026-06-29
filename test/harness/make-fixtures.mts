/**
 * Build normalized, REDACTED telemetry fixtures from real coding sessions already
 * on disk (Claude / Codex / Grok), so the GenAI-semconv adapter has a real-world
 * test corpus that never leaks prompt/code content.
 *
 *   npx tsx test/harness/make-fixtures.mts [countPerAgent=2]
 *
 * Writes test/fixtures/real/<agent>/<sessionId>.json — { meta, turns } with all
 * free text replaced by `<redacted len=N>` and tool inputs dropped (names, roles,
 * usage, timing, and tool-call structure are preserved — that's all the adapter
 * needs). Also writes manifest.json. Re-runnable + deterministic.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportedSession } from '../../packages/agent/src/adapters/import';
import { discoverGrokSessions, parseGrokSession } from '../../packages/agent/src/adapters/grok';
import { discoverCodexSessions, parseCodexSession } from '../../packages/agent/src/adapters/codex';
import { listClaudeTranscripts } from '../../packages/agent/src/commands';
import { CaptureEngine } from '../../packages/agent/src/capture';
import { StateStore } from '../../packages/agent/src/state';
import { defaultConfig } from '../../packages/agent/src/config';
import { readTurns } from '../../packages/agent/src/store/writer';
import { sessionDir } from '../../packages/agent/src/store/paths';
import type { Turn } from '@unpolarize/code-sessions-schema';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'fixtures', 'real');
const N = Number(process.argv[2] ?? 2);

// Map each distinct real project path to a synthetic one — preserves "different
// project → different path" (so project-enrichment tests work) without leaking names.
const projectAlias = new Map<string, string>();
function anonProject(p: string | undefined): string | undefined {
  if (!p) return p;
  if (!projectAlias.has(p)) projectAlias.set(p, `/work/project-${String.fromCharCode(97 + projectAlias.size)}`);
  return projectAlias.get(p);
}

function redactMeta(meta: any): unknown {
  const m: any = { session_id: meta.session_id };
  if (meta.model) m.model = meta.model;
  if (meta.started_at) m.started_at = meta.started_at;
  if (meta.ended_at) m.ended_at = meta.ended_at;
  if (meta.project_path) m.project_path = anonProject(meta.project_path);
  if (meta.title) m.title = `<redacted len=${String(meta.title).length}>`;
  return m;
}

/**
 * Whitelist ONLY the fields the adapter needs — never spread the turn, because
 * the schema is `.passthrough()` and real turns carry `cwd`, tool-result `content`,
 * etc. that would leak prompts/code. Text is length-stamped; tool inputs dropped.
 */
function redactTurn(t: Turn): Turn {
  return {
    schema: t.schema,
    session_id: t.session_id,
    host: t.host,
    agent: t.agent,
    turn_index: t.turn_index,
    ts: t.ts,
    role: t.role,
    text: t.text ? `<redacted len=${t.text.length}>` : '',
    tool_calls: t.tool_calls.map((c) => ({ name: c.name, input: {}, ...(c.id ? { id: c.id } : {}) })),
    usage: {
      input_tokens: t.usage.input_tokens,
      output_tokens: t.usage.output_tokens,
      cache_read_tokens: t.usage.cache_read_tokens,
      cache_write_tokens: t.usage.cache_write_tokens,
    },
    scrubbed: t.scrubbed,
    raw_ref: null,
    ...(t.telemetry?.cost_usd ? { telemetry: { cost_usd: t.telemetry.cost_usd } } : {}),
  } as Turn;
}

function writeFixture(agent: string, sessionId: string, meta: unknown, turns: Turn[]): void {
  const dir = join(OUT, agent);
  mkdirSync(dir, { recursive: true });
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  writeFileSync(
    join(dir, `${safe}.json`),
    `${JSON.stringify({ agent, sessionId, meta: redactMeta(meta), turns: turns.map(redactTurn) }, null, 2)}\n`,
  );
}

/** Has at least one assistant turn with usage AND at least one tool call → exercises chat + execute_tool. */
function isRich(turns: Turn[]): boolean {
  const hasUsage = turns.some((t) => t.role === 'assistant' && (t.usage.input_tokens > 0 || t.usage.output_tokens > 0));
  const hasTool = turns.some((t) => t.tool_calls.length > 0);
  const hasUser = turns.some((t) => t.role === 'user');
  return hasUser && hasTool && (hasUsage || true);
}

const manifest: Array<{ agent: string; sessionId: string; turns: number; tools: number }> = [];

function take(agent: string, sessions: ImportedSession[]): void {
  let n = 0;
  for (const s of sessions) {
    if (n >= N) break;
    if (!s.turns.length || !isRich(s.turns)) continue;
    writeFixture(agent, s.sessionId, s.meta, s.turns);
    manifest.push({
      agent,
      sessionId: s.sessionId,
      turns: s.turns.length,
      tools: s.turns.reduce((a, t) => a + t.tool_calls.length, 0),
    });
    n++;
  }
  console.log(`${agent}: wrote ${n} fixture(s)`);
}

rmSync(OUT, { recursive: true, force: true });

// Codex + Grok parse straight to ImportedSession.
take('codex', discoverCodexSessions().map((i) => parseCodexSession(i, 'fixture-host')).filter(Boolean) as ImportedSession[]);
take('grok', discoverGrokSessions().map((i) => parseGrokSession(i, 'fixture-host')).filter(Boolean) as ImportedSession[]);

// Claude: run the real capture engine over transcripts into a throwaway store, then read back canonical turns.
{
  const tmp = join(HERE, '..', '.tmp-claude-store');
  rmSync(tmp, { recursive: true, force: true });
  const cfg = { ...defaultConfig(), host: 'fixture-host', storeDir: tmp }; // real ~/.claude/projects, throwaway store
  const engine = new CaptureEngine(cfg, new StateStore(join(tmp, 'state.json')));
  const claude: ImportedSession[] = [];
  for (const tr of listClaudeTranscripts(cfg.claudeProjectsDir).slice(0, 200)) {
    try {
      const res = engine.captureSession(tr.sessionId, tr.path);
      if (!res.envelope) continue;
      const turns = readTurns(sessionDir(tmp, 'fixture-host', res.month, tr.sessionId));
      claude.push({ host: 'fixture-host', sessionId: tr.sessionId, agent: 'claude-code', turns, meta: { session_id: tr.sessionId, model: res.envelope.model, started_at: res.envelope.started_at } });
    } catch {
      /* skip unparseable */
    }
    if (claude.filter((c) => isRich(c.turns)).length >= N) break;
  }
  take('claude', claude);
  rmSync(tmp, { recursive: true, force: true });
}

writeFixture; // keep referenced
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ generated: 'redacted from real on-disk sessions', fixtures: manifest }, null, 2)}\n`);
console.log(`manifest: ${manifest.length} fixtures → ${OUT}`);
