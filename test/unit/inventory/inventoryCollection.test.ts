import { Decimal128, Int32, Long, ObjectId, type Db, Double } from 'mongodb';
import { describe, expect, it } from 'vitest';
import inventoryCollection from '../../../src/inventory/inventoryCollection.js';
import { memoryContext } from '../../helpers.js';

interface Scripted { count: number; indexes: Record<string, unknown>[]; docs: Record<string, unknown>[]; failCount?: Error[] }

/** A `Db` whose one collection answers the four calls inventory makes and records their options. */
function fakeDb(script: Scripted) {
  const calls: { op: string; args: unknown[] }[] = [];
  const failCount = [...(script.failCount ?? [])];
  const coll = {
    async estimatedDocumentCount(options: unknown) {
      calls.push({ op: 'estimatedDocumentCount', args: [options] });
      const err = failCount.shift();
      if (err) throw err;
      return script.count;
    },
    listIndexes() {
      calls.push({ op: 'listIndexes', args: [] });
      return { toArray: async () => script.indexes };
    },
    find(filter: unknown, options: Record<string, unknown>) {
      calls.push({ op: 'find', args: [filter, options] });
      const sorted = [...script.docs].sort((a, b) => (String(a._id) < String(b._id) ? 1 : -1));
      return { toArray: async () => sorted.slice(0, options.limit as number) };
    },
    async findOne(filter: unknown, options: Record<string, unknown>) {
      calls.push({ op: 'findOne', args: [filter, options] });
      const direction = (options.sort as Record<string, number>)._id as number;
      const ids = script.docs.map((d) => d._id).filter((id) => id instanceof ObjectId).sort((a, b) => (String(a) < String(b) ? -1 : 1) * direction);
      return ids.length > 0 ? { _id: ids[0] } : null;
    },
  };
  const db = { collection: (name: string) => { calls.push({ op: 'collection', args: [name] }); return coll; } };
  return { db: db as unknown as Db, calls };
}

const oid = (seconds: number) => ObjectId.createFromTime(seconds);
const day = 86_400;

describe('inventoryCollection', () => {
  it('reads count, leading index fields, id types and top-level dates, then suggests a strategy', async () => {
    const { ctx, events, config } = memoryContext({ command: 'inventory' });
    const t0 = Date.UTC(2026, 2, 1) / 1000;
    const docs = Array.from({ length: 10 }, (_, i) => ({
      _id: oid(t0 + i * day), created_at: new Date(Date.UTC(2026, 2, 1 + i)), ...(i < 9 ? { updated_at: new Date() } : {}), n: new Int32(i),
    }));
    const { db, calls } = fakeDb({
      count: 4_000_000, docs,
      indexes: [{ name: '_id_', key: { _id: 1 } }, { name: 'created_at_-1', key: { created_at: -1 } }, { name: 'a_1_b_1', key: { a: 1, b: 1 } }],
    });

    const inv = await inventoryCollection(ctx, db, 'orders', 5);
    expect(inv).toMatchObject({
      name: 'orders', estimatedCount: 4_000_000, indexedFields: ['_id', 'created_at', 'a'], idTypes: { objectId: 5 },
      // The newest five documents are sampled and the newest one has no updated_at.
      dateFields: [{ field: 'created_at', ratio: 1, indexed: true }, { field: 'updated_at', ratio: 0.8, indexed: false }],
      objectIdTime: { min: '2026-03-01T00:00:00Z', max: '2026-03-10T00:00:00Z' },
    });
    // Nine days of ids for four million documents: well under two million a day, so day windows.
    expect(inv.suggestion).toMatchObject({ name: 'orders', strategy: 'objectid-window', window: 'day', rest: 'auto' });

    expect(calls.map((c) => c.op)).toEqual(['collection', 'estimatedDocumentCount', 'listIndexes', 'find', 'findOne', 'findOne']);
    expect(calls[1]?.args).toEqual([{ maxTimeMS: config.mongo.maxTimeMs }]);
    expect(calls[3]?.args).toEqual([{}, { sort: { _id: -1 }, limit: 5, batchSize: 5, maxTimeMS: config.mongo.maxTimeMs }]);
    expect(calls[4]?.args[1]).toMatchObject({ hint: '_id_' });
    expect(events).toEqual([{ type: 'info', command: 'inventory', message: 'orders: about 4,000,000 documents, objectid-window' }]);
  });

  it('names BSON wrapper types the way $type does and skips the bounds read without ObjectIds', async () => {
    const { ctx } = memoryContext({ command: 'inventory' });
    const { db, calls } = fakeDb({
      count: 10, indexes: [{ name: '_id_', key: { _id: 1 } }],
      docs: [{ _id: new Int32(1) }, { _id: Long.fromNumber(2) }, { _id: new Decimal128('3') }, { _id: 'four' }, { _id: null }, { _id: new Date(0) }, { _id: { a: 1 } }, { _id: new Int32(7) }, { _id: new Double(7.5) }],
    });
    const inv = await inventoryCollection(ctx, db, 'misc', 100);
    expect(inv.idTypes).toEqual({ int: 2, long: 1, decimal: 1, string: 1, null: 1, date: 1, object: 1, double: 1 });
    expect(inv.objectIdTime).toBeNull();
    expect(inv.dateFields).toEqual([]);
    expect(calls.some((c) => c.op === 'findOne')).toBe(false);
    expect(inv.suggestion.strategy).toBe('full-collection');
  });

  it('warns when a large collection gets no window', async () => {
    const { ctx, events } = memoryContext({ command: 'inventory' });
    const { db } = fakeDb({ count: 2_000_000, indexes: [{ name: '_id_', key: { _id: 1 } }], docs: [{ _id: 'a' }, { _id: 'b' }] });
    const inv = await inventoryCollection(ctx, db, 'misc', 100);
    expect(inv.suggestion.reason).toBe('large collection, one keyset chunk');
    expect(events.filter((e) => e.type === 'warn')).toEqual([{ type: 'warn', command: 'inventory', message: 'misc: large collection, one keyset chunk' }]);
  });

  it('retries a transient driver error like the export does', async () => {
    const { ctx, events } = memoryContext({ command: 'inventory' });
    const transient = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const { db, calls } = fakeDb({ count: 3, indexes: [], docs: [], failCount: [transient] });
    const inv = await inventoryCollection(ctx, db, 'empty', 10);
    expect(inv).toMatchObject({ estimatedCount: 3, indexedFields: [], idTypes: {}, dateFields: [], objectIdTime: null });
    expect(calls.filter((c) => c.op === 'estimatedDocumentCount')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'retry')).toMatchObject([{ source: 'mongo', name: 'empty estimatedDocumentCount', attempt: 1 }]);
  });
});
