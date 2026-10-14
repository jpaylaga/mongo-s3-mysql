import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import identifier from '#infer/identifier';
import fitIdentifier from '#mysql/fitIdentifier';

describe('fitIdentifier', () => {
  it('keeps names up to 64 characters; longer ones get the first 57 plus 6 hex of sha1', () => {
    expect(fitIdentifier('a'.repeat(64))).toBe('a'.repeat(64));

    const long = `${'a'.repeat(70)}bcde`;
    const fitted = fitIdentifier(long);

    expect(fitted).toHaveLength(64);

    expect(fitted).toBe(
      `${'a'.repeat(57)}_${createHash('sha1').update(long, 'utf8').digest('hex').slice(0, 6)}`
    );

    expect(fitIdentifier(`${'a'.repeat(70)}bcdf`)).not.toBe(fitted);
    // infer's identifiers and the DDL index names go through the same rule.
    expect(identifier(long)).toBe(fitted);
  });
});
