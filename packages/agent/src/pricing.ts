import type { Usage } from '@unpolarize/code-sessions-schema';

/** Per-million-token list prices (USD). Approximate; override per real tier. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<string, ModelPrice> = {
  'claude-opus-4-8': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-haiku': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const DEFAULT_PRICE: ModelPrice = PRICES['claude-sonnet']!;

export function priceFor(model: string | undefined): ModelPrice {
  if (!model) return DEFAULT_PRICE;
  const lower = model.toLowerCase();
  for (const key of Object.keys(PRICES)) {
    if (lower.includes(key)) return PRICES[key]!;
  }
  if (lower.includes('opus')) return PRICES['claude-opus']!;
  if (lower.includes('sonnet')) return PRICES['claude-sonnet']!;
  if (lower.includes('haiku')) return PRICES['claude-haiku']!;
  return DEFAULT_PRICE;
}

/** Estimate USD cost of one turn's usage. cost = sum(tokens * $/M) / 1e6. */
export function estimateCostUsd(usage: Usage, model?: string): number {
  const p = priceFor(model);
  const dollars =
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_read_tokens * p.cacheRead +
      usage.cache_write_tokens * p.cacheWrite) /
    1_000_000;
  // round to 6 dp to avoid float noise
  return Math.round(dollars * 1e6) / 1e6;
}
