import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import objectIdAt from '#mongo/objectIdAt';

describe('objectIdAt', () => {
  it('builds the lowest ObjectId of a second: the window boundary value', () => {
    const at = new Date('2026-03-03T00:00:00.750Z');
    const id = objectIdAt(at);

    expect(id).toBeInstanceOf(ObjectId);
    expect(id.getTimestamp().toISOString()).toBe('2026-03-03T00:00:00.000Z');

    expect(id.toHexString()).toBe(
      `${Math.floor(at.getTime() / 1000).toString(16)}0000000000000000`
    );
  });
});
