import type { Intent, Signal, Turn } from '@unpolarize/code-sessions-schema';

/**
 * Deterministic, LLM-free signal derivation. Runs regardless of provider so the
 * store always has a useful baseline; the configured agent adds topic/tags/summary
 * on top. Pure functions, easy to test.
 */

export const THRESHOLDS = {
  stuckRepeat: 3, // N consecutive identical assistant/tool actions
  highCostUsd: 0.5,
  longSessionTurns: 80,
  toolHeavyRatio: 1.5,
};

const ERROR_RE = /(error|exception|traceback|failed|fatal|panic)/i;

function actionKey(t: Turn): string {
  if (t.tool_calls.length > 0) {
    return `tool:${t.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.input ?? null)})`).join(',')}`;
  }
  return `${t.role}:${t.text.slice(0, 120)}`;
}

export function deriveSignals(turns: Turn[]): Signal[] {
  const signals: Signal[] = [];

  // stuck-loop: the same action repeated >= N times in a row
  let runKey = '';
  let runLen = 0;
  let runStart = 0;
  let flaggedStuck = false;
  for (let i = 0; i < turns.length; i++) {
    const key = actionKey(turns[i]!);
    if (key === runKey) {
      runLen++;
    } else {
      runKey = key;
      runLen = 1;
      runStart = i;
    }
    if (runLen >= THRESHOLDS.stuckRepeat && !flaggedStuck) {
      signals.push({
        kind: 'stuck-loop',
        severity: 'warn',
        turn_index: turns[runStart]!.turn_index,
        note: `repeated action ×${runLen}`,
      });
      flaggedStuck = true;
    }
  }

  // error-recovery: a tool/assistant turn whose text mentions an error
  for (const t of turns) {
    if (ERROR_RE.test(t.text)) {
      signals.push({ kind: 'error-recovery', severity: 'info', turn_index: t.turn_index });
      break;
    }
  }

  // high-cost-turn
  for (const t of turns) {
    const cost = t.telemetry?.cost_usd ?? 0;
    if (cost >= THRESHOLDS.highCostUsd) {
      signals.push({
        kind: 'high-cost-turn',
        severity: 'warn',
        turn_index: t.turn_index,
        note: `$${cost.toFixed(2)}`,
      });
      break;
    }
  }

  // long-session
  if (turns.length >= THRESHOLDS.longSessionTurns) {
    signals.push({ kind: 'long-session', severity: 'info', note: `${turns.length} turns` });
  }

  // tool-heavy
  const toolCalls = turns.reduce((a, t) => a + t.tool_calls.length, 0);
  if (turns.length > 0 && toolCalls / turns.length >= THRESHOLDS.toolHeavyRatio) {
    signals.push({
      kind: 'tool-heavy',
      severity: 'info',
      note: `${toolCalls} tool calls / ${turns.length} turns`,
    });
  }

  return signals;
}

/** A cheap, deterministic topic guess: first meaningful words of the first user turn. */
export function guessTopic(turns: Turn[]): string | undefined {
  const firstUser = turns.find((t) => t.role === 'user' && t.text.trim().length > 0);
  if (!firstUser) return undefined;
  const words = firstUser.text.trim().split(/\s+/).slice(0, 8).join(' ');
  return words.length > 0 ? words : undefined;
}

/** Tags from distinct tool names used in the session. */
export function deriveTags(turns: Turn[]): string[] {
  const tags = new Set<string>();
  for (const t of turns) for (const c of t.tool_calls) tags.add(c.name);
  return [...tags].slice(0, 12);
}

/** Map an edited file path to a coarse project id (…/projects/<id>, …/docs → docs). */
export function projectIdFromPath(p: string): string | null {
  const segs = p.split('/').filter(Boolean);
  const i = segs.indexOf('projects');
  if (i >= 0 && segs[i + 1] === 'ai' && segs[i + 2]) return `ai/${segs[i + 2]}`;
  if (i >= 0 && segs[i + 1]) return segs[i + 1]!;
  if (segs.includes('docs')) return 'docs';
  return null;
}

/** Projects the session touched, from Edit/Write/Read tool file paths. */
export function deriveProjects(turns: Turn[]): string[] {
  const set = new Set<string>();
  for (const t of turns) {
    for (const c of t.tool_calls) {
      const fp = (c.input as { file_path?: string; path?: string } | undefined)?.file_path
        ?? (c.input as { path?: string } | undefined)?.path;
      if (typeof fp === 'string') {
        const id = projectIdFromPath(fp);
        if (id) set.add(id);
      }
    }
  }
  return [...set].sort().slice(0, 12);
}

const INTENT_PATTERNS: [Intent, RegExp][] = [
  ['bugfix', /\b(fix|bug|broken|error|crash|regression|failing|stack ?trace)\b/i],
  ['feature', /\b(add|implement|build|create|feature|support|introduce|new )\b/i],
  ['refactor', /\b(refactor|clean ?up|simplify|rename|restructure|extract|dedupe)\b/i],
  ['research', /\b(research|investigate|explore|compare|evaluate|find out|how (do|does|to)|why)\b/i],
  ['docs', /\b(document|docs|readme|write[ -]?up|notes|comment)\b/i],
  ['review', /\b(review|audit|critique|check|inspect)\b/i],
  ['ops', /\b(deploy|release|publish|install|configure|ci\/?cd|pipeline|infra)\b/i],
];

/** Classify the session's intent from the first substantive user prompt. */
export function deriveIntent(turns: Turn[]): Intent | undefined {
  const firstUser = turns.find((t) => t.role === 'user' && t.text.trim().length > 0);
  if (!firstUser) return undefined;
  const text = firstUser.text;
  for (const [intent, re] of INTENT_PATTERNS) {
    if (re.test(text)) return intent;
  }
  return 'other';
}
