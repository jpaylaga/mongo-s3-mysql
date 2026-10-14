import { MongoNetworkError, MongoServerError, ObjectId, type Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import inventory from '../../../src/inventory/inventory.js';
import msmError from '../../../src/runtime/msmError.js';
import type { MongoHandle } from '../../../src/types.js';
import { exampleConfig, memoryContext } from '../../helpers.js';

interface Listed { name: string; type?: string; count?: number; fail?: Error }

/** A `MongoHandle` over scripted collections; each reads as a tiny ObjectId collection unless told to fail. */
function fakeMongo(listed: Listed[]) {
  const read: string[] = [];
  const byName = new Map(listed.map((c) => [c.name, c]));
  const collection = (name: string) => {
    const script = byName.get(name);
    return {
      async estimatedDocumentCount() {
        read.push(name);
        if (script?.fail) throw script.fail;
        return script?.count ?? 3;
      },
      listIndexes: () => ({ toArray: async () => [{ name: '_id_', key: { _id: 1 } }] }),
      find: () => ({ toArray: async () => [{ _id: new ObjectId() }] }),
      findOne: async () => ({ _id: new ObjectId() }),
    };
  };
  const db = { collection, listCollections: () => ({ toArray: async () => listed.map(({ name, type }) => ({ name, type })) }) };
  const mongo = { db: db as unknown as Db, client: {}, close: async () => {} } as unknown as MongoHandle;
  return { mongo, read };
}

const listing: Listed[] = [
  { name: 'orders', type: 'collection' }, { name: 'audit_log', type: 'collection' }, { name: 'coupons', type: 'collection' },
  { name: 'sessions', type: 'collection' }, { name: 'daily_totals', type: 'view' }, { name: 'metrics', type: 'timeseries' },
  { name: 'system.views', type: 'collection' }, { name: 'untyped' },
];

describe('inventory', () => {
  it('reads the configured collections by default and reports them in that order', async () => {
    const { ctx } = memoryContext({ command: 'inventory' });
    const { mongo, read } = fakeMongo(listing);
    const report = await inventory({ ctx, mongo });
    expect(report.collections.map((c) => c.name)).toEqual(['audit_log', 'orders', 'coupons']);
    expect(report.skipped).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(new Set(read)).toEqual(new Set(['audit_log', 'orders', 'coupons']));
    expect(report.collections[0]?.suggestion).toMatchObject({ name: 'audit_log', strategy: 'full-collection' });
  });

  it('-C names win, and a name the server does not have is skipped as not found', async () => {
    const { ctx } = memoryContext({ command: 'inventory' });
    const { mongo } = fakeMongo(listing);
    const report = await inventory({ ctx, mongo, names: ['sessions', 'nope'] });
    expect(report.collections.map((c) => c.name)).toEqual(['sessions']);
    expect(report.skipped).toEqual([{ name: 'nope', reason: 'not found' }]);
    expect(report.exitCode).toBe(0);
  });

  it('--all (or an empty configured list) reads every listed collection, skipping views, time-series and system ones', async () => {
    const { ctx } = memoryContext({ command: 'inventory' });
    const { mongo } = fakeMongo(listing);
    const all = await inventory({ ctx, mongo, all: true });
    expect(all.collections.map((c) => c.name)).toEqual(['audit_log', 'coupons', 'orders', 'sessions', 'untyped']);
    expect(all.skipped).toEqual([
      { name: 'daily_totals', reason: 'view is not exportable' },
      { name: 'metrics', reason: 'timeseries is not exportable' },
      { name: 'system.views', reason: 'system collection' },
    ]);
    expect(all.exitCode).toBe(0);

    const none = memoryContext({ command: 'inventory', config: exampleConfig({ collections: [] }) });
    const unconfigured = await inventory({ ctx: none.ctx, mongo });
    expect(unconfigured.collections.map((c) => c.name)).toEqual(all.collections.map((c) => c.name));
  });

  it('skips a collection that fails for a non-fatal reason, warns, and exits incomplete', async () => {
    const { ctx, events } = memoryContext({ command: 'inventory' });
    const unauthorized = new MongoServerError({ message: 'not authorized on app to execute command (user hunter2)', code: 8000 });
    const slow = new MongoServerError({ message: 'operation exceeded time limit', code: 50 });
    const { mongo } = fakeMongo([{ name: 'orders', type: 'collection', fail: slow }, { name: 'audit_log', type: 'collection' }, { name: 'coupons', type: 'collection' }]);
    const report = await inventory({ ctx, mongo });
    expect(report.collections.map((c) => c.name)).toEqual(['audit_log', 'coupons']);
    expect(report.skipped).toEqual([{ name: 'orders', reason: 'operation exceeded time limit' }]);
    expect(report.exitCode).toBe(2);
    expect(events.filter((e) => e.type === 'warn')).toEqual([{ type: 'warn', command: 'inventory', message: 'orders: skipped (mongo): operation exceeded time limit' }]);

    // Fatal errors (authorization) stop the whole inventory rather than hiding in a skip.
    const fatal = fakeMongo([{ name: 'orders', type: 'collection', fail: unauthorized }, { name: 'audit_log', type: 'collection' }, { name: 'coupons', type: 'collection' }]);
    await expect(inventory({ ctx, mongo: fatal.mongo })).rejects.toBe(unauthorized);
  });

  it('retries transient errors first and keeps the sample size it was given', async () => {
    const { ctx, events } = memoryContext({ command: 'inventory' });
    let attempts = 0;
    const flaky = { name: 'orders', type: 'collection' } as Listed;
    const { mongo } = fakeMongo([flaky, { name: 'audit_log', type: 'collection' }, { name: 'coupons', type: 'collection' }]);
    const original = mongo.db.collection.bind(mongo.db);
    (mongo.db as { collection: unknown }).collection = (name: string) => {
      const coll = original(name) as unknown as { estimatedDocumentCount(): Promise<number> };
      if (name === 'orders') {
        coll.estimatedDocumentCount = async () => { attempts += 1; if (attempts === 1) throw new MongoNetworkError('reset'); return 9; };
      }
      return coll;
    };
    const report = await inventory({ ctx, mongo, names: ['orders'], sampleSize: 7 });
    expect(report.collections[0]?.estimatedCount).toBe(9);
    expect(attempts).toBe(2);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
  });

  it('reports an interrupted run as a result with the signal exit code and the collections read so far, like every other command', async () => {
    const controller = new AbortController();
    const { ctx } = memoryContext({ command: 'inventory', signal: controller.signal });
    const stops = fakeMongo([{ name: 'orders', type: 'collection', fail: msmError('mongo', 'late') }]);
    controller.abort('SIGTERM');
    // Already aborted before the listing: nothing read, exit 143.
    expect(await inventory({ ctx, mongo: stops.mongo, names: ['orders'] })).toEqual({ collections: [], skipped: [], exitCode: 143 });
    // Aborted while the first collection is read: what was read before stays in the report.
    const mid = new AbortController();
    const midCtx = memoryContext({ command: 'inventory', signal: mid.signal }).ctx;
    const { mongo } = fakeMongo([{ name: 'audit_log', type: 'collection' }, { name: 'orders', type: 'collection' }, { name: 'coupons', type: 'collection' }]);
    const original = mongo.db.collection.bind(mongo.db);
    (mongo.db as { collection: unknown }).collection = (name: string) => {
      const coll = original(name) as unknown as { estimatedDocumentCount(): Promise<number> };
      if (name === 'coupons') coll.estimatedDocumentCount = async () => { mid.abort('SIGINT'); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
      return coll;
    };
    const report = await inventory({ ctx: midCtx, mongo, names: ['audit_log', 'orders', 'coupons'] });
    expect(report.exitCode).toBe(130);
    expect(report.collections.map((c) => c.name).sort()).toEqual(['audit_log', 'orders']);
  });
});
