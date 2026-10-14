import { MongoServerError, type Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import countDocs from '../../../src/mongo/countDocs.js';
import { memoryContext } from '../../helpers.js';
import { fakeCollection } from '../export/fakeMongo.js';

describe('countDocs', () => {
  it('counts under the hint with the configured maxTimeMS and returns the hint it used, as a number', async () => {
    const { ctx } = memoryContext();
    const fake = fakeCollection({ name: 'c', counts: [7] });
    expect(await countDocs(ctx, fake.coll, { a: 1 }, 'a_1', 'count c')).toEqual({ count: 7, hint: 'a_1' });
    expect(fake.calls).toEqual([{ method: 'countDocuments', args: [{ a: 1 }, { hint: 'a_1', maxTimeMS: 1_800_000 }] }]);
    expect(await countDocs(ctx, fakeCollection({ name: 'c', counts: [3] }).coll, {}, null, 'count c')).toEqual({ count: 3, hint: null });
  });

  it('falls back to an unhinted count when the server refuses the hint, and propagates every other error', async () => {
    const { ctx } = memoryContext();
    const refused = fakeCollection({ name: 'c', counts: [5], countWithHintError: new MongoServerError({ message: 'hint provided does not correspond to an existing index', code: 2 }) });
    expect(await countDocs(ctx, refused.coll, {}, 'a_1', 'count c')).toEqual({ count: 5, hint: null });
    expect(refused.calls.map((c) => (c.args[1] as Document).hint)).toEqual(['a_1', undefined]);
    const other = fakeCollection({ name: 'c', countWithHintError: new MongoServerError({ message: 'operation exceeded time limit', code: 50 }) });
    await expect(countDocs(ctx, other.coll, {}, 'a_1', 'count c')).rejects.toMatchObject({ code: 50 });
  });
});
