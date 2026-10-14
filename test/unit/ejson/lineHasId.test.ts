import { describe, expect, it } from 'vitest';
import lineHasId from '#ejson/lineHasId';

describe('lineHasId', () => {
  it('is true with an _id, false without one or for a non-document, null for non-JSON', () => {
    expect(lineHasId('{"_id":{"$oid":"65f1c0a1b2c3d4e5f6a7b8c9"}}')).toBe(true);
    expect(lineHasId('{"_id":null}')).toBe(true);
    expect(lineHasId('{"n":1}')).toBe(false);
    expect(lineHasId('[1]')).toBe(false);
    expect(lineHasId('"s"')).toBe(false);
    expect(lineHasId('{ not json')).toBeNull();
  });
});
