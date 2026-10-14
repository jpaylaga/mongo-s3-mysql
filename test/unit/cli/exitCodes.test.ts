import { describe, expect, it } from 'vitest';
import exitCodes from '#cli/exitCodes';

describe('exitCodes', () => {
  it('matches the documented table', () => {
    expect(exitCodes).toEqual({
      ok: 0,
      error: 1,
      incomplete: 2,
      invalid: 3,
      drift: 4,
      sigint: 130,
      sigterm: 143,
    });
  });
});
