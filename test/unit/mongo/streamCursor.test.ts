import type { Collection, Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import streamCursor from '#mongo/streamCursor';
import type { ChunkPlan } from '#types';
import { memoryContext } from '../../helpers.js';

function fakeCollection(docs: Document[], failAt?: number) {
  const calls: { filter: unknown; options: unknown }[] = [];
  let closed = 0;

  const coll = {
    find(filter: unknown, options: unknown) {
      calls.push({ filter, options });

      return {
        async *[Symbol.asyncIterator]() {
          for (const [i, d] of docs.entries()) {
            if (i === failAt) throw new Error('cursor died');

            yield d;
          }
        },
        async close() {
          closed += 1;
        },
      };
    },
  };

  return { coll: coll as unknown as Collection, calls, closed: () => closed };
}

const plan = (hint: string | null): ChunkPlan => ({
  collection: 'audit_log',
  runId: 'r',
  mode: 'timestamp-window',
  tail: 'window',
  filter: { created_at: { $gte: 1, $lt: 2 } },
  filterRecord: {},
  hint,
  paging: 'cursor',
  brackets: [],
  rawPrefix: 'raw/',
});

describe('streamCursor', () => {
  it('runs one hinted unsorted find with the configured batch size and maxTimeMS', async () => {
    const { ctx } = memoryContext();
    const { coll, calls, closed } = fakeCollection([{ _id: 1 }, { _id: 2 }]);
    const out: Document[] = [];

    for await (const d of streamCursor(coll, plan('created_at_1'), ctx)) out.push(d);

    expect(out).toEqual([{ _id: 1 }, { _id: 2 }]);

    expect(calls[0]).toEqual({
      filter: { created_at: { $gte: 1, $lt: 2 } },
      options: { hint: 'created_at_1', batchSize: 1000, maxTimeMS: 1_800_000 },
    });

    expect(closed()).toBe(1);
  });

  it('omits the hint when the plan has none and propagates cursor errors', async () => {
    const { ctx } = memoryContext();
    const { coll, calls, closed } = fakeCollection([{ _id: 1 }, { _id: 2 }], 1);
    const out: Document[] = [];

    await expect(
      (async () => {
        for await (const d of streamCursor(coll, plan(null), ctx)) out.push(d);
      })()
    ).rejects.toThrow('cursor died');

    expect(calls[0]?.options).not.toHaveProperty('hint');
    expect(out).toEqual([{ _id: 1 }]);
    expect(closed()).toBe(1);
  });

  it('stops between documents when the signal aborts', async () => {
    const controller = new AbortController();
    const { ctx } = memoryContext({ signal: controller.signal });
    const { coll } = fakeCollection([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
    const out: Document[] = [];

    await expect(
      (async () => {
        for await (const d of streamCursor(coll, plan(null), ctx)) {
          out.push(d);
          controller.abort('SIGINT');
        }
      })()
    ).rejects.toMatchObject({ msmCode: 'interrupted' });

    expect(out).toEqual([{ _id: 1 }]);
  });
});
