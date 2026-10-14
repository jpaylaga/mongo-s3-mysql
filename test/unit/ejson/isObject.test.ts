import { describe, expect, it } from 'vitest';
import isObject from '../../../src/ejson/isObject.js';

describe('isObject', () => {
  it('is a plain object: not null, not an array', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject([])).toBe(false);
    expect(isObject('x')).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});
