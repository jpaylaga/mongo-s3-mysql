import { describe, expect, it } from 'vitest';
import parseList from '../../../src/cli/parseList.js';

describe('parseList', () => {
  it('splits on commas, trims, and drops blanks', () => {
    expect(parseList(undefined)).toEqual([]);
    expect(parseList('')).toEqual([]);
    expect(parseList(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(parseList(',')).toEqual([]);
  });
});
