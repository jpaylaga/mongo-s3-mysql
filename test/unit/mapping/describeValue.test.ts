import { describe, expect, it } from 'vitest';
import describeValue from '#mapping/describeValue';

describe('describeValue', () => {
  it('names what JSON.parse gave without echoing the value', () => {
    expect(describeValue(undefined)).toBe('missing');
    expect(describeValue(null)).toBe('null');
    expect(describeValue([1])).toBe('an array');
    expect(describeValue({ $numberLong: '5' })).toBe('a $numberLong value');
    expect(describeValue({ a: 1 })).toBe('an object');
    expect(describeValue('x'.repeat(1000))).toBe('a string');
    expect(describeValue(5)).toBe('a number');
  });
});
