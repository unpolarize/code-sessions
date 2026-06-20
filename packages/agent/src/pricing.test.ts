import { describe, expect, it } from 'vitest';
import { estimateCostUsd, priceFor } from './pricing';

describe('pricing', () => {
  it('selects a price table by fuzzy model match', () => {
    expect(priceFor('claude-opus-4-8').output).toBe(75);
    expect(priceFor('claude-haiku-4-5-20251001').output).toBe(5);
    expect(priceFor('something-sonnet-ish').output).toBe(15);
    expect(priceFor(undefined).output).toBe(15); // default = sonnet
  });

  it('computes cost as sum(tokens * $/M) / 1e6', () => {
    const cost = estimateCostUsd(
      { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      'claude-opus-4-8',
    );
    expect(cost).toBe(15);
  });

  it('returns 0 for empty usage', () => {
    expect(
      estimateCostUsd(
        { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
        'claude-opus-4-8',
      ),
    ).toBe(0);
  });
});
