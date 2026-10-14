import { describe, expect, it } from 'vitest';
import recordError from '#verify/recordError';

describe('recordError', () => {
  it('keeps the first four lines of a prettified zod error: trimmed, no blanks, joined', () => {
    expect(
      recordError(
        'k: invalid record\n  x Invalid input: expected number\n    at ' +
          'exported_count\n\n  x another\n  x fifth line'
      )
    ).toBe('record: k: invalid record; x Invalid input: expected number; at exported_count');

    expect(recordError('a\nb\nc\nd\ne')).toBe('record: a; b; c; d');
    expect(recordError('k: invalid JSON')).toBe('record: k: invalid JSON');
  });
});
