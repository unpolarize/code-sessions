import { spawnSync } from 'node:child_process';
import { INTENTS, SIGNAL_KINDS, type Signal } from '@unpolarize/code-sessions-schema';
import type { LabelRequest, LabelResult, Provider } from './provider';

/** Runs a prompt against some agent CLI/API and returns its raw text output. */
export type CommandRunner = (prompt: string) => Promise<string>;

const MAX_HEAD = 40;
const MAX_TAIL = 10;
const MAX_TURN_CHARS = 400;

export function buildPrompt(req: LabelRequest): string {
  const turns = req.turns;
  const picked =
    turns.length > MAX_HEAD + MAX_TAIL
      ? [...turns.slice(0, MAX_HEAD), { role: '…', text: `(${turns.length - MAX_HEAD - MAX_TAIL} turns elided)`, tool_calls: [] as unknown[] }, ...turns.slice(-MAX_TAIL)]
      : turns;
  const transcript = picked
    .map((t) => {
      const tools = (t as { tool_calls?: { name: string }[] }).tool_calls
        ?.map((c) => c.name)
        .join(',');
      const head = tools ? `[${t.role} tools:${tools}]` : `[${t.role}]`;
      return `${head} ${String(t.text).slice(0, MAX_TURN_CHARS)}`;
    })
    .join('\n');

  return [
    'You label a coding-agent session. Respond with ONLY a JSON object, no prose:',
    '{"topic": string, "intent": one of ' +
      INTENTS.join('|') +
      ', "tags": string[], "projects": string[], "summary": string, "signals": [{"kind": one of ' +
      SIGNAL_KINDS.join('|') +
      ', "severity": "info"|"warn"|"critical", "note": string}]}',
    'topic: 3-6 words. intent: what the user wanted. tags: tools/themes. projects: repo/dir names touched. summary: <=1 sentence. signals: only notable ones.',
    '',
    'Transcript:',
    transcript,
  ].join('\n');
}

const KIND_SET = new Set<string>(SIGNAL_KINDS);

export function parseLabelJson(out: string): LabelResult {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end <= start) return { tags: [], projects: [], signals: [] };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { tags: [], projects: [], signals: [] };
  }
  const result: LabelResult = {
    tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : [],
    projects: Array.isArray(obj.projects)
      ? obj.projects.filter((t): t is string => typeof t === 'string')
      : [],
    signals: coerceSignals(obj.signals),
  };
  if (typeof obj.topic === 'string') result.topic = obj.topic;
  if (typeof obj.summary === 'string') result.summary = obj.summary;
  if (typeof obj.intent === 'string' && (INTENTS as readonly string[]).includes(obj.intent)) {
    result.intent = obj.intent as LabelResult['intent'];
  }
  return result;
}

function coerceSignals(raw: unknown): Signal[] {
  if (!Array.isArray(raw)) return [];
  const out: Signal[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (typeof o.kind !== 'string' || !KIND_SET.has(o.kind)) continue;
    const sig: Signal = {
      kind: o.kind as Signal['kind'],
      severity:
        o.severity === 'warn' || o.severity === 'critical' ? o.severity : 'info',
    };
    if (typeof o.note === 'string') sig.note = o.note;
    if (typeof o.turn_index === 'number') sig.turn_index = o.turn_index;
    out.push(sig);
  }
  return out;
}

/** A provider that shells out to a user-configured agent CLI/API. */
export class LlmProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly runner: CommandRunner,
  ) {}

  async label(req: LabelRequest): Promise<LabelResult> {
    const out = await this.runner(buildPrompt(req));
    return parseLabelJson(out);
  }
}

// ---- concrete runners (best-effort; require the tool to be installed) ----

function spawnText(cmd: string, args: string[], input?: string): string {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw new Error(`${cmd} failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} exited ${res.status}: ${(res.stderr ?? '').slice(0, 200)}`);
  return res.stdout ?? '';
}

/** `claude -p <prompt>` (print mode). */
export const claudeRunner =
  (model?: string): CommandRunner =>
  async (prompt) =>
    spawnText('claude', model ? ['-p', '--model', model, prompt] : ['-p', prompt]);

/** `grok` CLI in non-interactive mode (best-effort flags). */
export const grokRunner =
  (model?: string): CommandRunner =>
  async (prompt) =>
    spawnText('grok', model ? ['--model', model, '-p', prompt] : ['-p', prompt]);

/** Local Ollama HTTP API. */
export const ollamaRunner =
  (model = 'llama3.1', host = 'http://localhost:11434'): CommandRunner =>
  async (prompt) => {
    const res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { response?: string };
    return data.response ?? '';
  };
