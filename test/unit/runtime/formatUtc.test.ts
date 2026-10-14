import { describe, expect, it } from 'vitest';
import formatUtc from '../../../src/runtime/formatUtc.js';

describe('formatUtc', () => {
  const d = new Date('2026-03-02T00:00:01.527Z');

  it('writes the three real styles at second precision', () => {
    expect(formatUtc(d, 'compact')).toBe('20260302T000001Z');
    expect(formatUtc(d, 'offset')).toBe('2026-03-02T00:00:01+00:00');
    expect(formatUtc(d, 'z')).toBe('2026-03-02T00:00:01Z');
  });

  it('truncates rather than rounds and rejects invalid dates', () => {
    expect(formatUtc(new Date('2026-12-31T23:59:59.999Z'), 'z')).toBe('2026-12-31T23:59:59Z');
    expect(() => formatUtc(new Date('nope'), 'z')).toThrow(RangeError);
  });
});
