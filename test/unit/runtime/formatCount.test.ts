import { describe, expect, it } from 'vitest';
import formatCount from '#runtime/formatCount';

describe('formatCount', () => {
  it('groups thousands with commas whatever the host locale', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
});
