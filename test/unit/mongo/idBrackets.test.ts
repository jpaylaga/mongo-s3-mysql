import { Binary, ObjectId, Timestamp } from 'mongodb';
import { describe, expect, it } from 'vitest';
import idBrackets from '../../../src/mongo/idBrackets.js';

describe('idBrackets', () => {
  it('lists the eight brackets in BSON comparison order with their lowest values', () => {
    expect(idBrackets.map((b) => b.name)).toEqual(['number', 'string', 'object', 'binData', 'objectId', 'bool', 'date', 'timestamp']);
    expect(idBrackets[0]?.lowest).toBe(-Infinity);
    expect(idBrackets[0]?.types).toEqual(['int', 'long', 'double', 'decimal']);
    expect(idBrackets[1]?.lowest).toBe('');
    expect(idBrackets[2]?.lowest).toEqual({});
    expect(idBrackets[3]?.lowest).toBeInstanceOf(Binary);
    expect((idBrackets[3]?.lowest as Binary).length()).toBe(0);
    expect((idBrackets[4]?.lowest as ObjectId).toHexString()).toBe('000000000000000000000000');
    expect(idBrackets[5]?.lowest).toBe(false);
    expect((idBrackets[6]?.lowest as Date).getTime()).toBe(-8.64e15);
    expect(idBrackets[7]?.lowest).toBeInstanceOf(Timestamp);
  });

  it('covers every exportable _id type exactly once', () => {
    const all = idBrackets.flatMap((b) => b.types);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain('null');
    expect(all).not.toContain('minKey');
  });
});
