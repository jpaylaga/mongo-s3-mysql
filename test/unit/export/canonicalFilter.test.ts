import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import canonicalFilter from '#export/canonicalFilter';

describe('canonicalFilter', () => {
  it('writes dates and ids as canonical Extended JSON wrappers', () => {
    const filter = {
      created_at: { $gte: new Date('2026-03-02T00:00:00Z') },
      _id: { $lt: new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9') },
      n: 1,
    };

    expect(canonicalFilter(filter)).toEqual({
      created_at: { $gte: { $date: { $numberLong: '1772409600000' } } },
      _id: { $lt: { $oid: '65f1c0a1b2c3d4e5f6a7b8c9' } },
      n: { $numberInt: '1' },
    });
  });
});
