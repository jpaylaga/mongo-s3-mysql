import { describe, expect, it } from 'vitest';
import lineHasId from '../../../src/ejson/lineHasId.js';

describe('lineHasId', () => {
  it('is true for a document with an _id, false for one without or a non-document, null when the line is not JSON', () => {
    expect(lineHasId('{"_id":{"$oid":"65f1c0a1b2c3d4e5f6a7b8c9"}}')).toBe(true);
    expect(lineHasId('{"_id":null}')).toBe(true);
    expect(lineHasId('{"n":1}')).toBe(false);
    expect(lineHasId('[1]')).toBe(false);
    expect(lineHasId('"s"')).toBe(false);
    expect(lineHasId('{ not json')).toBeNull();
  });
});
