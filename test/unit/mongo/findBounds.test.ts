import type { Collection } from 'mongodb';
import { describe, expect, it } from 'vitest';
import findBounds from '#mongo/findBounds';

function fakeCollection(docs: Record<string, unknown>[]) {
  const calls: { filter: unknown; options: Record<string, unknown> }[] = [];

  const coll = {
    async findOne(filter: Record<string, unknown>, options: Record<string, any>) {
      calls.push({ filter, options });

      const [field, direction] = Object.entries(options.sort as Record<string, number>)[0] as [
        string,
        number,
      ];

      const at = (d: Record<string, unknown>) =>
        field
          .split('.')
          .reduce<unknown>(
            (v, k) =>
              typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined,
            d
          ) as number;

      const sorted = [...docs].sort((a, b) => (at(a) < at(b) ? -1 : 1) * direction);

      return sorted[0] ?? null;
    },
  };

  return { coll: coll as unknown as Collection, calls };
}

describe('findBounds', () => {
  it('reads a field min and max with the index-name hint and a date type filter', async () => {
    const { coll, calls } = fakeCollection([
      { _id: 1, created_at: 20 },
      { _id: 2, created_at: 5 },
      { _id: 3, created_at: 30 },
    ]);

    expect(await findBounds(coll, { field: 'created_at', hint: 'created_at_1' }, 1000)).toEqual({
      min: 5,
      max: 30,
    });

    expect(calls).toHaveLength(2);

    expect(calls[0]).toEqual({
      filter: { created_at: { $type: 'date' } },
      options: {
        sort: { created_at: 1 },
        hint: 'created_at_1',
        projection: { _id: 1, created_at: 1 },
        maxTimeMS: 1000,
      },
    });

    expect(calls[1]?.options).toMatchObject({ sort: { created_at: -1 }, hint: 'created_at_1' });
  });

  it('reads ObjectId bounds on _id with the _id_ hint', async () => {
    const { coll, calls } = fakeCollection([{ _id: 'b' }, { _id: 'a' }]);

    expect(await findBounds(coll, { objectId: true }, 5)).toEqual({ min: 'a', max: 'b' });

    expect(calls[0]).toEqual({
      filter: { _id: { $type: 'objectId' } },
      options: { sort: { _id: 1 }, hint: '_id_', projection: { _id: 1 }, maxTimeMS: 5 },
    });
  });

  it('resolves a dotted field through the nested document the server returns', async () => {
    const { coll } = fakeCollection([
      { _id: 1, meta: { ts: 20 } },
      { _id: 2, meta: { ts: 5 } },
    ]);

    expect(await findBounds(coll, { field: 'meta.ts', hint: 'meta.ts_1' }, 5)).toEqual({
      min: 5,
      max: 20,
    });
  });

  it('returns null for an empty collection', async () => {
    const { coll } = fakeCollection([]);

    expect(await findBounds(coll, { objectId: true }, 5)).toBeNull();
  });
});
