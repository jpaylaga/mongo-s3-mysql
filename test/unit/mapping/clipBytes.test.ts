import { describe, expect, it } from 'vitest';
import clipBytes from '#mapping/clipBytes';

describe('clipBytes', () => {
  it('keeps text that fits and cuts at a character boundary otherwise', () => {
    expect(clipBytes('abc', 3)).toBe('abc');
    expect(clipBytes('abcd', 3)).toBe('abc');
    // A 4-byte character straddling the limit is dropped whole.
    expect(clipBytes('ab\u{1F600}', 5)).toBe('ab');
    expect(clipBytes('ab\u{1F600}', 6)).toBe('ab\u{1F600}');
    expect(clipBytes('x'.repeat(20_000))).toHaveLength(16_384);
  });
});
