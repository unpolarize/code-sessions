import type { Turn } from '@unpolarize/code-sessions-schema';
import type { CommandRunner } from './llm';

/**
 * Per-turn category classification. Maps each turn to exactly one of a
 * user-configured taxonomy via a single batched LLM call (the ollama runner in
 * practice — see `makeTurnClassifier`). The runner is injected, so parsing and
 * validation are deterministic to test. Output is validated against the allowed
 * category list; anything unrecognized is dropped rather than trusted.
 */

export interface TurnCategory {
  turn_index: number;
  category: string;
}

const MAX_TURNS = 60;
const MAX_TURN_CHARS = 240;

export function buildClassifyPrompt(turns: Turn[], categories: string[]): string {
  const lines = turns.map((t) => {
    const tools = t.tool_calls.map((c) => c.name).join(',');
    const head = tools ? `[${t.turn_index} ${t.role} tools:${tools}]` : `[${t.turn_index} ${t.role}]`;
    return `${head} ${t.text.slice(0, MAX_TURN_CHARS).replace(/\s+/g, ' ')}`;
  });
  const body =
    lines.length > MAX_TURNS
      ? [...lines.slice(0, MAX_TURNS), `(+${lines.length - MAX_TURNS} more turns)`].join('\n')
      : lines.join('\n');
  return [
    'Classify each turn of a coding-agent session into exactly one category.',
    `Allowed categories: ${categories.join(', ')}.`,
    'Respond with ONLY a JSON array, no prose:',
    '[{"turn_index": <number from [brackets]>, "category": "<one allowed category>"}]',
    'Exactly one entry per turn; use the category that best fits what happened in that turn.',
    '',
    'Turns:',
    body,
  ].join('\n');
}

/** Parse + validate the model output against the turns and allowed categories. */
export function parseTurnCategories(out: string, turns: Turn[], categories: string[]): TurnCategory[] {
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(out.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const canonical = new Map(categories.map((c) => [c.toLowerCase(), c]));
  const validIndex = new Set(turns.map((t) => t.turn_index));
  const seen = new Set<number>();
  const result: TurnCategory[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const idx = o.turn_index;
    const cat = o.category;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || !validIndex.has(idx) || seen.has(idx)) continue;
    if (typeof cat !== 'string') continue;
    const canon = canonical.get(cat.toLowerCase());
    if (!canon) continue;
    seen.add(idx);
    result.push({ turn_index: idx, category: canon });
  }
  return result;
}

/** Classify every turn into one configured category. Degrades to [] on any failure. */
export async function classifyTurns(
  turns: Turn[],
  categories: string[],
  runner: CommandRunner,
): Promise<TurnCategory[]> {
  if (categories.length === 0 || turns.length === 0) return [];
  let out: string;
  try {
    out = await runner(buildClassifyPrompt(turns, categories));
  } catch {
    return [];
  }
  return parseTurnCategories(out, turns, categories);
}
