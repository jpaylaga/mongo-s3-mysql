import { describe, expect, it } from 'vitest';
import msmError from '#runtime/msmError';

describe('msmError', () => {
  it('builds an Error with the tool fields and defaults', () => {
    const err = msmError('s3', 'bucket gone');

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MsmError');
    expect(err.message).toBe('bucket gone');
    expect(err.msmCode).toBe('s3');
    expect(err.retriable).toBeNull();
    expect(err.fatal).toBe(false);
    expect(err.cause).toBeUndefined();
  });

  it('keeps cause, retriable and fatal', () => {
    const cause = new Error('inner');
    const err = msmError('lock', 'held', { cause, retriable: false, fatal: true });

    expect(err.cause).toBe(cause);
    expect(err.retriable).toBe(false);
    expect(err.fatal).toBe(true);
  });
});
