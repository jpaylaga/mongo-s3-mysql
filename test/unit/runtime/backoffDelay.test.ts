import { describe, expect, it } from 'vitest';
import backoffDelay from '../../../src/runtime/backoffDelay.js';

describe('backoffDelay', () => {
  it('doubles the ceiling per attempt up to maxMs with full jitter', () => {
    expect(backoffDelay(1, 500, 60_000, () => 1)).toBe(500);
    expect(backoffDelay(2, 500, 60_000, () => 1)).toBe(1000);
    expect(backoffDelay(4, 500, 60_000, () => 1)).toBe(4000);
    expect(backoffDelay(20, 500, 60_000, () => 1)).toBe(60_000);
    expect(backoffDelay(3, 500, 60_000, () => 0)).toBe(0);
    expect(backoffDelay(3, 500, 60_000, () => 0.5)).toBe(1000);
  });

  it('stays within [0, ceiling] with the real random source', () => {
    for (let i = 0; i < 200; i += 1) {
      const d = backoffDelay(5, 500, 60_000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });

  it('adds up to minutes over the default eight attempts', () => {
    let total = 0;
    for (let a = 1; a < 8; a += 1) total += backoffDelay(a, 500, 60_000, () => 1);
    expect(total).toBe(63_500);
  });
});
