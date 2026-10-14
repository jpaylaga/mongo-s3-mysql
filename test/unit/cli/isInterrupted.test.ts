import { describe, expect, it } from 'vitest';
import exitCodes from '../../../src/cli/exitCodes.js';
import isInterrupted from '../../../src/cli/isInterrupted.js';

describe('isInterrupted', () => {
  it('is true for the two signal codes only', () => {
    expect(isInterrupted(exitCodes.sigint)).toBe(true);
    expect(isInterrupted(exitCodes.sigterm)).toBe(true);
    for (const code of [exitCodes.ok, exitCodes.error, exitCodes.incomplete, exitCodes.invalid, exitCodes.drift]) expect(isInterrupted(code)).toBe(false);
  });
});
