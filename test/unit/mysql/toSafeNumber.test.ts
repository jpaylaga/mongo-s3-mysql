import { describe, expect, it } from 'vitest';
import toSafeNumber from '#mysql/toSafeNumber';

describe('toSafeNumber', () => {
  it('reads strings and bigints, null is 0, anything outside 0..2^53-1 is a fatal error', () => {
    expect(toSafeNumber('42', 'x')).toBe(42);
    expect(toSafeNumber(42n, 'x')).toBe(42);
    expect(toSafeNumber(null, 'x')).toBe(0);
    expect(toSafeNumber(undefined, 'x')).toBe(0);
    expect(toSafeNumber(String(Number.MAX_SAFE_INTEGER), 'x')).toBe(Number.MAX_SAFE_INTEGER);

    expect(() => toSafeNumber('9007199254740992', 'lines_done')).toThrow(
      expect.objectContaining({
        msmCode: 'mysql',
        fatal: true,
        message: 'lines_done 9007199254740992 is outside 0..2^53-1',
      })
    );

    expect(() => toSafeNumber('-1', 'x')).toThrow(/outside 0\.\.2\^53-1/);
  });
});
