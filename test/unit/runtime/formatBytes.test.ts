import { describe, expect, it } from 'vitest';
import formatBytes from '#runtime/formatBytes';

describe('formatBytes', () => {
  it('keeps bytes whole and gives one decimal from KB up', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(329_849)).toBe('322.1 KB');
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.0 TB');
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000.0 TB');
  });
});
