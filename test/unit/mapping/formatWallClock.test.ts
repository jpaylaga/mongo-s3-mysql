import { describe, expect, it } from 'vitest';
import formatWallClock from '#mapping/formatWallClock';

const manilaExample = 1772409601527; // 2026-03-02T00:00:01.527Z, the docs/use-case.md example

describe('formatWallClock', () => {
  it('writes the UTC wall clock with exactly fsp digits, truncated', () => {
    expect(formatWallClock(manilaExample, 'UTC', 0)).toBe('2026-03-02 00:00:01');
    expect(formatWallClock(manilaExample, 'UTC', 1)).toBe('2026-03-02 00:00:01.5');
    expect(formatWallClock(manilaExample, 'UTC', 3)).toBe('2026-03-02 00:00:01.527');
    expect(formatWallClock(manilaExample, 'UTC', 6)).toBe('2026-03-02 00:00:01.527000');
    expect(formatWallClock(1772409601999, 'UTC', 2)).toBe('2026-03-02 00:00:01.99');
  });

  it('writes the Asia/Manila wall clock like the application rows', () => {
    expect(formatWallClock(manilaExample, 'Asia/Manila', 0)).toBe('2026-03-02 08:00:01');

    expect(formatWallClock(Date.UTC(2026, 2, 2, 16, 0, 0), 'Asia/Manila', 0)).toBe(
      '2026-03-03 00:00:00'
    );
  });

  it('uses a 24-hour clock with 00 at midnight and pads early years', () => {
    expect(formatWallClock(Date.UTC(2026, 0, 1, 0, 0, 0), 'UTC', 0)).toBe('2026-01-01 00:00:00');

    expect(formatWallClock(Date.UTC(2026, 0, 1, 23, 59, 59), 'America/New_York', 0)).toBe(
      '2026-01-01 18:59:59'
    );

    expect(formatWallClock(Date.UTC(999, 0, 1, 12, 0, 0), 'UTC', 0)).toMatch(
      /^0999-01-01 12:00:00$/
    );
  });

  it('handles negative epoch milliseconds and refuses non-finite input', () => {
    expect(formatWallClock(-1, 'UTC', 3)).toBe('1969-12-31 23:59:59.999');
    expect(() => formatWallClock(Number.NaN, 'UTC', 0)).toThrow(RangeError);
  });
});
