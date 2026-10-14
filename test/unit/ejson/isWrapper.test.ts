import { describe, expect, it } from 'vitest';
import isWrapper from '#ejson/isWrapper';

describe('isWrapper', () => {
  it('is an object whose every key starts with $, and never the empty object', () => {
    expect(isWrapper({ $oid: 'x' })).toBe(true);
    expect(isWrapper({ $binary: { base64: 'x', subType: '00' } })).toBe(true);
    expect(isWrapper({})).toBe(false);
    expect(isWrapper({ $oid: 'x', other: 1 })).toBe(false);
    expect(isWrapper({ a: 1 })).toBe(false);
  });
});
