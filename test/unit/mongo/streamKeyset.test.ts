import { ObjectId, type Collection, type Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import idBrackets from '../../../src/mongo/idBrackets.js';
import streamKeyset from '../../../src/mongo/streamKeyset.js';
import type { ChunkPlan } from '../../../src/types.js';
import { memoryContext } from '../../helpers.js';

interface Call { query: Document; sort: unknown; hint: unknown; limit: number; maxTimeMS: number }

/** Scripted keyset pages: `pages` answers each find in order; `failAt` throws a transient error on that call index. */
function fakeCollection(pages: Document[][], failAt: number[] = []) {
  const calls: Call[] = [];
  const coll = {
    find(query: Document) {
      const call: Call = { query, sort: null, hint: null, limit: 0, maxTimeMS: 0 };
      const index = calls.length;
      calls.push(call);
      const cursor = {
        sort(s: unknown) { call.sort = s; return cursor; },
        hint(h: unknown) { call.hint = h; return cursor; },
        limit(l: number) { call.limit = l; return cursor; },
        maxTimeMS(m: number) { call.maxTimeMS = m; return cursor; },
        async toArray() {
          if (failAt.includes(index)) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
          return pages.shift() ?? [];
        },
      };
      return cursor;
    },
  };
  return { coll: coll as unknown as Collection, calls };
}

const plan = (filter: Document, brackets = idBrackets): ChunkPlan => ({
  collection: 'orders', runId: 'r', mode: 'full-collection', tail: 'full',
  filter, filterRecord: {}, hint: '_id_', paging: 'keyset', brackets, rawPrefix: 'raw/',
});

async function run(coll: Collection, p: ChunkPlan, ctx: ReturnType<typeof memoryContext>['ctx']) {
  const out: unknown[] = [];
  for await (const d of streamKeyset(coll, p, ctx)) out.push(d._id);
  return out;
}

describe('streamKeyset', () => {
  it('walks every bracket in order, opening each with $gte lowest and paging with $gt last', async () => {
    const { ctx, config } = memoryContext();
    config.export.keysetPageDocs = 2;
    const { coll, calls } = fakeCollection([[{ _id: 1 }, { _id: 2 }], [{ _id: 3 }], [{ _id: 'a' }], [], [], [], [], [], []]);
    const two = [idBrackets[0]!, idBrackets[1]!];
    expect(await run(coll, plan({}, two), ctx)).toEqual([1, 2, 3, 'a']);
    expect(calls.map((c) => c.query)).toEqual([{ _id: { $gte: -Infinity } }, { _id: { $gt: 2 } }, { _id: { $gte: '' } }]);
    expect(calls.every((c) => c.hint === '_id_' && c.limit === 2 && c.maxTimeMS === 1_800_000)).toBe(true);
    expect(calls[0]?.sort).toEqual({ _id: 1 });
  });

  it('ANDs the plan filter into every page (window and rest chunks) and skips empty brackets', async () => {
    const { ctx, config } = memoryContext();
    config.export.keysetPageDocs = 10;
    const start = new ObjectId('000000000000000000000000');
    const window = { _id: { $gte: start, $lt: ObjectId.createFromTime(86400) } };
    const { coll, calls } = fakeCollection([[{ _id: 'x' }]]);
    expect(await run(coll, plan(window, [idBrackets[4]!]), ctx)).toEqual(['x']);
    expect(calls[0]?.query).toEqual({ $and: [window, { _id: { $gte: start } }] });
    const rest = { $or: [{ created_at: { $not: { $type: 'date' } } }] };
    const all = fakeCollection(idBrackets.map(() => []));
    expect(await run(all.coll, plan(rest), ctx)).toEqual([]);
    expect(all.calls).toHaveLength(8);
    expect(all.calls.map((c) => (c.query as { $and: Document[] }).$and[0])).toEqual(idBrackets.map(() => rest));
  });

  it('retries a failed page from last and emits a retry event', async () => {
    const { ctx, config, events } = memoryContext();
    config.export.keysetPageDocs = 1;
    const { coll, calls } = fakeCollection([[{ _id: 1 }], [{ _id: 2 }], []], [1]);
    expect(await run(coll, plan({}, [idBrackets[0]!]), ctx)).toEqual([1, 2]);
    expect(calls.map((c) => c.query)).toEqual([{ _id: { $gte: -Infinity } }, { _id: { $gt: 1 } }, { _id: { $gt: 1 } }, { _id: { $gt: 2 } }]);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
  });

  it('refuses an embedded-document _id with an integer-like key at any depth, which JavaScript reorders', async () => {
    const { ctx } = memoryContext();
    const parse = { msmCode: 'parse', message: expect.stringContaining('integer-like key') };
    const { coll } = fakeCollection([[{ _id: { b: 1, 1: 2 } }]]);
    await expect(run(coll, plan({}, [idBrackets[2]!]), ctx)).rejects.toMatchObject(parse);
    // The same reordering happens inside a nested subdocument and inside an array element.
    const nested = fakeCollection([[{ _id: { a: { b: 1, 1: 2 } } }]]);
    await expect(run(nested.coll, plan({}, [idBrackets[2]!]), ctx)).rejects.toMatchObject(parse);
    const inArray = fakeCollection([[{ _id: { a: [{ b: 1, 7: 2 }] } }]]);
    await expect(run(inArray.coll, plan({}, [idBrackets[2]!]), ctx)).rejects.toMatchObject(parse);
    const fine = fakeCollection([[{ _id: { b: 1, a: { c: 2, d: [new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9')] } } }]]);
    expect(await run(fine.coll, plan({}, [idBrackets[2]!]), ctx)).toHaveLength(1);
  });

  it('stops between documents when aborted', async () => {
    const controller = new AbortController();
    const { ctx } = memoryContext({ signal: controller.signal });
    const { coll } = fakeCollection([[{ _id: 1 }, { _id: 2 }]]);
    const out: unknown[] = [];
    await expect((async () => {
      for await (const d of streamKeyset(coll, plan({}, [idBrackets[0]!]), ctx)) { out.push(d._id); controller.abort('SIGINT'); }
    })()).rejects.toMatchObject({ msmCode: 'interrupted' });
    expect(out).toEqual([1]);
  });
});
