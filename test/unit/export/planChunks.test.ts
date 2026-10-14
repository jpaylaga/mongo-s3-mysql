import { Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import createExportLedger from '#export/createExportLedger';
import planChunks from '#export/planChunks';
import idBrackets from '#mongo/idBrackets';
import type { BatchPlan, CollectionConfig, ExportDeps, PlannedCollection } from '#types';
import { memoryContext } from '../../helpers.js';
import { fakeCollection, fakeMongo } from './fakeMongo.js';
import type { FakeCollectionSpec } from './fakeMongo.js';

const batchId = 'b1';
const cutoff = new Date('2026-03-04T12:00:00Z');
const dayMs = 86_400_000;
/**
 * The rest chunk's after-cutoff term starts a day after the batch started (here: at the cutoff):
 * the live gap.
 */
const afterGap = new Date(cutoff.getTime() + dayMs);

const batch = (collections: PlannedCollection[], over: Partial<BatchPlan> = {}): BatchPlan => ({
  batchId,
  kind: 'full',
  cutoff,
  since: null,
  startedAt: cutoff,
  collections,
  includeRest: false,
  resumed: false,
  outOfRange: {},
  ...over,
});

const cc = (over: Partial<CollectionConfig> & { name: string }): CollectionConfig => ({
  window: 'day',
  rest: 'auto',
  ...over,
});

function setup(spec: FakeCollectionSpec) {
  const mc = memoryContext();
  const fake = fakeCollection(spec);

  const deps: ExportDeps = {
    mongo: fakeMongo([fake]),
    store: mc.store,
    layout: mc.layout,
    ledger: createExportLedger('/nowhere', 'x'),
  };

  return { ...mc, deps, fake };
}

const counts = (filter: Document): number => {
  const text = JSON.stringify(filter);

  if (text.includes('$not') || text.includes('$or')) return 0; // untyped

  if (text.includes('$lt') && !text.includes('$gte')) return 7; // before_start

  if (text.includes('$gte') && !text.includes('$lt')) return 2; // after_cutoff

  return 0;
};

describe('planChunks', () => {
  it('plans one manifest-only chunk for an empty collection', async () => {
    const { ctx, deps } = setup({ name: 'coupons', empty: true });

    const plan: PlannedCollection = {
      collection: 'coupons',
      mode: 'full-collection',
      field: null,
      window: null,
      start_utc: null,
      rest: false,
    };

    const { chunks, outOfRange } = await planChunks(
      ctx,
      deps,
      batch([plan]),
      cc({ name: 'coupons', strategy: 'full-collection' })
    );

    expect(outOfRange).toBeNull();
    expect(chunks).toHaveLength(1);

    expect(chunks[0]).toMatchObject({
      runId: 'b1-coupons-manifest-only-full',
      mode: 'manifest-only',
      paging: 'none',
      hint: null,
      brackets: [],
      filterRecord: {
        mode: 'manifest-only',
        filter: 'no raw export; manifest and validation only',
      },
    });
  });

  it('plans a keyset walk over every bracket for full-collection', async () => {
    const { ctx, deps, layout } = setup({ name: 'coupons', docs: [{ _id: 'SPRING10' }] });

    const plan: PlannedCollection = {
      collection: 'coupons',
      mode: 'full-collection',
      field: null,
      window: null,
      start_utc: null,
      rest: false,
    };

    const { chunks } = await planChunks(
      ctx,
      deps,
      batch([plan]),
      cc({ name: 'coupons', strategy: 'full-collection' })
    );

    expect(chunks[0]).toMatchObject({
      runId: 'b1-coupons-full-collection-full',
      mode: 'full-collection',
      tail: 'full',
      paging: 'keyset',
      hint: '_id_',
      filter: {},
      filterRecord: { mode: 'full-collection', filter: 'all documents', hint: '_id_', query: {} },
      rawPrefix: layout.rawPrefix('coupons', null, 'b1-coupons-full-collection-full'),
    });

    expect(chunks[0]?.brackets).toBe(idBrackets);
  });

  it('clips the day grid, picks the plainest index and counts out-of-range docs', async () => {
    const { ctx, deps, fake, events } = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      bounds: { min: new Date('2026-03-02T10:30:00Z'), max: new Date('2026-03-04T20:00:00Z') },
      indexes: [
        { name: '_id_', key: { _id: 1 } },
        { name: 'actor_created', key: { created_at: 1, actor_id: 1 } },
        { name: 'created_desc', key: { created_at: -1 } },
      ],
      counts,
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: null,
      rest: false,
    };

    const { chunks, outOfRange } = await planChunks(
      ctx,
      deps,
      batch([plan]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(chunks.map(c => c.runId)).toEqual([
      'b1-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z',
      'b1-audit_log-timestamp-window-20260303T000000Z-20260304T000000Z',
      'b1-audit_log-timestamp-window-20260304T000000Z-20260304T120000Z',
    ]);

    expect(chunks[0]).toMatchObject({
      mode: 'timestamp-window',
      tail: 'window',
      paging: 'cursor',
      hint: 'created_desc',
      brackets: [],
      filter: {
        created_at: {
          $gte: new Date('2026-03-02T00:00:00Z'),
          $lt: new Date('2026-03-03T00:00:00Z'),
        },
      },
      filterRecord: {
        mode: 'timestamp-window',
        field: 'created_at',
        start_utc: '2026-03-02T00:00:00+00:00',
        end_utc: '2026-03-03T00:00:00+00:00',
        boundary: '[start,end)',
        hint: 'created_desc',
        query: {
          created_at: {
            $gte: { $date: { $numberLong: '1772409600000' } },
            $lt: { $date: { $numberLong: '1772496000000' } },
          },
        },
      },
    });

    expect(chunks[0]?.rawPrefix).toContain(
      'source_year=2026/source_month=03/source_day=02/source_hour=00/'
    );

    // No explicit start, so only after_cutoff and the untyped documents are counted, under the
    // field index hint.
    expect(outOfRange).toEqual({ before_start: 0, after_cutoff: 2, untyped: 0 });

    const countCalls = fake.calls.filter(c => c.method === 'countDocuments');

    expect(countCalls).toHaveLength(2);

    expect(countCalls[0]?.args).toEqual([
      { created_at: { $gte: cutoff } },
      { hint: 'created_desc', maxTimeMS: 1_800_000 },
    ]);

    expect(countCalls[1]?.args).toEqual([
      { created_at: { $not: { $type: 'date' } } },
      { hint: 'created_desc', maxTimeMS: 1_800_000 },
    ]);

    expect(
      fake.calls.find(c => c.method === 'findOne' && (c.args[1] as Document).sort)?.args[1]
    ).toMatchObject({ hint: 'created_desc' });

    expect(
      events.some(e => e.type === 'warn' && e.message.includes('2 at or after the cutoff'))
    ).toBe(true);
  });

  it('uses an explicit start as is, counts before_start, adds it to the rest filter', async () => {
    const { ctx, deps, fake } = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      indexes: [{ name: 'created_at_1', key: { created_at: 1 } }],
      counts,
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'hour',
      start_utc: '2026-03-04T09:30:00Z',
      rest: true,
    };

    const { chunks, outOfRange } = await planChunks(
      ctx,
      deps,
      batch([plan]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at', window: 'hour' })
    );

    expect(chunks.map(c => c.runId)).toEqual([
      'b1-audit_log-timestamp-window-20260304T093000Z-20260304T100000Z',
      'b1-audit_log-timestamp-window-20260304T100000Z-20260304T110000Z',
      'b1-audit_log-timestamp-window-20260304T110000Z-20260304T120000Z',
      'b1-audit_log-full-collection-rest',
    ]);

    expect(
      fake.calls.filter(c => c.method === 'findOne' && (c.args[1] as Document).sort)
    ).toHaveLength(0);

    expect(outOfRange).toEqual({ before_start: 7, after_cutoff: 2, untyped: 0 });

    const rest = chunks[3]!;

    expect(rest).toMatchObject({
      mode: 'full-collection',
      tail: 'rest',
      paging: 'keyset',
      hint: 'created_at_1',
      liveGap: { key: 'created_at', kind: 'date', startedAt: cutoff },
      filter: {
        $or: [
          { created_at: { $not: { $type: 'date' } } },
          { created_at: { $lt: new Date('2026-03-04T09:30:00Z') } },
          { created_at: { $gte: afterGap } },
        ],
      },
      filterRecord: {
        mode: 'full-collection',
        filter: 'documents outside the windows',
        hint: 'created_at_1',
      },
    });

    expect(rest.brackets).toBe(idBrackets);

    expect(rest.rawPrefix).toContain(
      'source_year=all/source_month=all/source_day=all/source_hour=all/' +
        'run_id=b1-audit_log-full-collection-rest/'
    );
  });

  it('leaves before_start out of the rest filter when it counts zero and in deltas', async () => {
    const zero = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      indexes: [{ name: 'created_at_1', key: { created_at: 1 } }],
      counts: () => 0,
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: '2026-03-04T00:00:00Z',
      rest: true,
    };

    const full = await planChunks(
      zero.ctx,
      zero.deps,
      batch([plan]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect((full.chunks[1]?.filter as { $or: Document[] }).$or).toHaveLength(2);

    const delta = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      indexes: [{ name: 'created_at_1', key: { created_at: 1 } }],
      counts,
    });

    const d = await planChunks(
      delta.ctx,
      delta.deps,
      batch([plan], { kind: 'delta', since: new Date('2026-03-04T00:00:00Z') }),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(d.outOfRange).toEqual({ before_start: 0, after_cutoff: 2, untyped: 0 });
    expect((d.chunks[1]?.filter as { $or: Document[] }).$or).toHaveLength(2);
    expect(delta.fake.calls.filter(c => c.method === 'countDocuments')).toHaveLength(2);
  });

  it('a late batch leaves a live-write day out of the rest chunk, returns its start', async () => {
    const startedAt = new Date('2026-03-04T14:00:00Z');

    const { ctx, deps, fake } = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      bounds: { min: new Date('2026-03-02T10:30:00Z'), max: new Date('2026-03-04T11:00:00Z') },
      indexes: [{ name: 'created_at_1', key: { created_at: 1 } }],
      counts,
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: null,
      rest: true,
    };

    const { chunks, start } = await planChunks(
      ctx,
      deps,
      batch([plan], { startedAt }),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(start?.toISOString()).toBe('2026-03-02T00:00:00.000Z');

    const rest = chunks.at(-1)!;

    expect((rest.filter as { $or: Document[] }).$or).toEqual([
      { created_at: { $not: { $type: 'date' } } },
      { created_at: { $gte: cutoff, $lt: startedAt } },
      { created_at: { $gte: new Date(startedAt.getTime() + dayMs) } },
    ]);

    // The out-of-range warning still counts everything at or after the cutoff.
    expect(fake.calls.filter(c => c.method === 'countDocuments').map(c => c.args[0])).toEqual([
      { created_at: { $gte: cutoff } },
      { created_at: { $not: { $type: 'date' } } },
    ]);
  });

  it('skips sparse and partial indexes, which would undercount a hinted rest chunk', async () => {
    const both = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      bounds: null,
      counts: () => 0,
      indexes: [
        { name: 'created_sparse', key: { created_at: 1 }, sparse: true },
        { name: 'created_partial', key: { created_at: 1 }, partialFilterExpression: { a: 1 } },
        { name: 'created_full', key: { created_at: 1, actor_id: 1 } },
      ] as never,
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: '2026-03-04T00:00:00Z',
      rest: false,
    };

    const { chunks } = await planChunks(
      both.ctx,
      both.deps,
      batch([plan]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(chunks[0]?.hint).toBe('created_full');

    const only = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      indexes: [{ name: 'created_sparse', key: { created_at: 1 }, sparse: true }] as never,
    });

    await expect(
      planChunks(
        only.ctx,
        only.deps,
        batch([plan]),
        cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining(
        'no complete (non-sparse, non-partial) ascending or descending index starts with created_at'
      ),
    });
  });

  it('skips hidden indexes, which cannot be hinted, and says so if none else leads', async () => {
    const both = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      bounds: null,
      counts: () => 0,
      indexes: [
        { name: 'a_t', key: { created_at: 1 }, hidden: true },
        { name: 'b_tx', key: { created_at: 1, actor_id: 1 } },
      ] as never,
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: '2026-03-04T00:00:00Z',
      rest: false,
    };

    const { chunks } = await planChunks(
      both.ctx,
      both.deps,
      batch([plan]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(chunks[0]?.hint).toBe('b_tx');

    const only = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      indexes: [{ name: 'a_t', key: { created_at: 1 }, hidden: true }] as never,
    });

    await expect(
      planChunks(
        only.ctx,
        only.deps,
        batch([plan]),
        cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message:
        'audit_log: only a hidden index starts with created_at; unhide it or add ' +
        'one, timestamp-window needs a visible index',
    });
  });

  it('a sentinel oldest date beyond the JS range is a config error, not a RangeError', async () => {
    const { ctx, deps } = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      bounds: { min: new Date(NaN), max: new Date('2026-01-02T00:00:00Z') },
      indexes: [{ name: 'created_at_1', key: { created_at: 1 } }],
      counts: () => 0,
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: null,
      rest: true,
    };

    await expect(
      planChunks(
        ctx,
        deps,
        batch([plan]),
        cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message:
        'audit_log: the oldest created_at is outside the JavaScript date range (a ' +
        'sentinel); set collections[].start so older documents go to the rest chunk',
    });

    // With a start set the sentinel documents count as before_start as usual.
    const bounded = await planChunks(
      ctx,
      deps,
      batch([{ ...plan, start_utc: '2026-03-01T00:00:00Z' }]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(bounded.chunks.map(c => c.tail)).toEqual([
      'window',
      'window',
      'window',
      'window',
      'rest',
    ]);
  });

  it('warns when the oldest value is the epoch, a sentinel under the window limit', async () => {
    const { ctx, deps, events } = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      bounds: { min: new Date(0), max: new Date('2026-03-04T02:00:00Z') },
      indexes: [{ name: 'created_at_1', key: { created_at: 1 } }],
      counts: () => 0,
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: null,
      rest: true,
    };

    const { chunks } = await planChunks(
      ctx,
      deps,
      batch([plan]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(chunks.length).toBeGreaterThan(20_000);

    expect(
      events.filter(e => e.type === 'warn').map(e => (e as { message: string }).message)
    ).toContain(
      'audit_log: the oldest created_at is exactly 1970-01-01T00:00:00Z (the ' +
        'epoch, a sentinel in most data); set collections[].start to the real start ' +
        'so older documents go to the rest chunk'
    );
  });

  it('fails fatally without a field index or when the collection is not in the plan', async () => {
    const { ctx, deps } = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      indexes: [
        { name: '_id_', key: { _id: 1 } },
        { name: 'actor', key: { actor_id: 1, created_at: 1 } },
      ],
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: null,
      rest: false,
    };

    await expect(
      planChunks(
        ctx,
        deps,
        batch([plan]),
        cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: expect.stringContaining('no ascending or descending index starts with created_at'),
    });

    await expect(
      planChunks(
        ctx,
        deps,
        batch([]),
        cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('not in the plan'),
    });
  });

  it('windows ObjectId time, pages the objectId bracket; the rest walks all others', async () => {
    const min = ObjectId.createFromTime(
      Math.floor(new Date('2026-03-03T05:00:00Z').getTime() / 1000)
    );

    const { ctx, deps, fake } = setup({
      name: 'orders',
      docs: [{ _id: min }],
      bounds: { min, max: min },
      counts,
    });

    const plan: PlannedCollection = {
      collection: 'orders',
      mode: 'objectid-window',
      field: null,
      window: 'day',
      start_utc: null,
      rest: true,
    };

    const { chunks, outOfRange } = await planChunks(
      ctx,
      deps,
      batch([plan]),
      cc({ name: 'orders', strategy: 'objectid-window' })
    );

    expect(chunks.map(c => c.runId)).toEqual([
      'b1-orders-objectid-window-20260303T000000Z-20260304T000000Z',
      'b1-orders-objectid-window-20260304T000000Z-20260304T120000Z',
      'b1-orders-full-collection-rest',
    ]);

    const first = chunks[0]!;

    expect(first).toMatchObject({
      paging: 'keyset',
      hint: '_id_',
      filterRecord: {
        mode: 'objectid-window',
        field: '_id',
        hint: '_id_',
        boundary: '[start,end)',
      },
    });

    expect(first.brackets.map(b => b.name)).toEqual(['objectId']);

    const range = (first.filter as { _id: { $gte: ObjectId; $lt: ObjectId } })._id;

    expect(range.$gte.getTimestamp().toISOString()).toBe('2026-03-03T00:00:00.000Z');
    expect(range.$lt.getTimestamp().toISOString()).toBe('2026-03-04T00:00:00.000Z');

    expect((first.filterRecord as { query: Document }).query).toEqual({
      _id: { $gte: { $oid: range.$gte.toHexString() }, $lt: { $oid: range.$lt.toHexString() } },
    });

    expect(outOfRange).toEqual({ before_start: 0, after_cutoff: 2, untyped: 0 });

    expect(
      fake.calls.find(c => c.method === 'findOne' && (c.args[1] as Document).sort)?.args[0]
    ).toEqual({ _id: { $type: 'objectId' } });

    const rest = chunks[2]!;
    const terms = (rest.filter as { $or: Document[] }).$or;

    expect(terms).toHaveLength(10);

    expect(terms.slice(0, 7).map(t => (t._id as { $gte: unknown }).$gte)).toEqual(
      idBrackets.filter(b => b.name !== 'objectId').map(b => b.lowest)
    );

    // Ids outside every bracket (null, MinKey, MaxKey, NaN, code, DBPointer) are counted so the
    // rest chunk flags instead of losing them.
    expect(terms[7]).toEqual({
      _id: {
        $type: ['null', 'minKey', 'maxKey', 'javascript', 'javascriptWithScope', 'dbPointer'],
      },
    });

    expect(terms[8]).toEqual({ _id: NaN });

    expect((terms[9]?._id as { $gte: ObjectId }).$gte.getTimestamp().toISOString()).toBe(
      afterGap.toISOString()
    );

    expect(rest.hint).toBe('_id_');

    // The untyped count runs the same terms without the live gap, hinted _id_.
    const untypedCall = fake.calls.filter(c => c.method === 'countDocuments')[1];

    expect((untypedCall?.args[0] as { $or: Document[] }).$or).toEqual(terms.slice(0, 9));
  });

  it('warns about untyped documents; with none in a window, it needs the rest chunk', async () => {
    const warned = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      bounds: { min: new Date('2026-03-04T01:00:00Z'), max: new Date('2026-03-04T02:00:00Z') },
      indexes: [{ name: 'created_at_1', key: { created_at: 1 } }],
      counts: filter => (JSON.stringify(filter).includes('$not') ? 5 : 0),
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: null,
      rest: false,
    };

    const { outOfRange } = await planChunks(
      warned.ctx,
      warned.deps,
      batch([plan]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(outOfRange).toEqual({ before_start: 0, after_cutoff: 0, untyped: 5 });

    expect(
      warned.events.filter(e => e.type === 'warn').map(e => (e as { message: string }).message)
    ).toContain('audit_log: 5 documents have no BSON date in created_at and are in no window');

    // No document has a date at all (ISO strings, say): without the rest chunk an empty plan would
    // commit as `complete`.
    const none = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      bounds: null,
      indexes: [{ name: 'created_at_1', key: { created_at: 1 } }],
      counts: () => 50,
    });

    await expect(
      planChunks(
        none.ctx,
        none.deps,
        batch([plan]),
        cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message:
        'audit_log: no document has a BSON date in created_at; windows need a date ' +
        'field (or pass --include-rest to export the collection as the rest chunk)',
    });

    const withRest = await planChunks(
      none.ctx,
      none.deps,
      batch([{ ...plan, rest: true }]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(withRest.chunks.map(c => c.tail)).toEqual(['rest']);
  });

  it('never hints a hashed index and reads a direction delivered as BSON Int32', async () => {
    const { ctx, deps } = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      bounds: null,
      counts: () => 0,
      indexes: [
        { name: 'created_at_hashed', key: { created_at: 'hashed' } },
        { name: 'created_actor', key: { created_at: new Int32(1), actor_id: new Int32(1) } },
      ],
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: '2026-03-04T00:00:00Z',
      rest: false,
    };

    const { chunks } = await planChunks(
      ctx,
      deps,
      batch([plan]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(chunks[0]?.hint).toBe('created_actor');

    const only = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      indexes: [{ name: 'created_at_hashed', key: { created_at: 'hashed' } }],
    });

    await expect(
      planChunks(
        only.ctx,
        only.deps,
        batch([plan]),
        cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('no ascending or descending index starts with created_at'),
    });
  });

  it('refuses more than 100,000 windows: a sentinel minimum needs an explicit start', async () => {
    const { ctx, deps } = setup({
      name: 'audit_log',
      docs: [{ _id: 1 }],
      bounds: { min: new Date('0001-01-01T00:00:00Z'), max: new Date('2026-03-04T02:00:00Z') },
      indexes: [{ name: 'created_at_1', key: { created_at: 1 } }],
      counts: () => 0,
    });

    const plan: PlannedCollection = {
      collection: 'audit_log',
      mode: 'timestamp-window',
      field: 'created_at',
      window: 'day',
      start_utc: null,
      rest: true,
    };

    await expect(
      planChunks(
        ctx,
        deps,
        batch([plan]),
        cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: expect.stringMatching(
        new RegExp(
          '^audit_log: the oldest created_at is 0001-01-01T00:00:00Z, ' +
            'which gives [\\d,]+ day windows \\(more than 100,000\\); ' +
            'set collections\\[\\]\\.start'
        )
      ),
    });

    // A hand-set start keeps the grid small; the older documents count as before_start and go to
    // the rest chunk.
    const bounded = await planChunks(
      ctx,
      deps,
      batch([{ ...plan, start_utc: '2026-03-01T00:00:00Z' }]),
      cc({ name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' })
    );

    expect(bounded.chunks).toHaveLength(5);
  });

  it('keeps the frozen out-of-range counts on resume and warns when no window fits', async () => {
    const { ctx, deps, fake, events } = setup({
      name: 'orders',
      docs: [{ _id: 1 }],
      bounds: null,
      counts,
    });

    const plan: PlannedCollection = {
      collection: 'orders',
      mode: 'objectid-window',
      field: null,
      window: 'day',
      start_utc: null,
      rest: true,
    };

    const resumed = batch([plan], {
      resumed: true,
      outOfRange: { orders: { before_start: 1, after_cutoff: 9 } },
    });

    const { chunks, outOfRange } = await planChunks(
      ctx,
      deps,
      resumed,
      cc({ name: 'orders', strategy: 'objectid-window' })
    );

    expect(chunks.map(c => c.tail)).toEqual(['rest']);
    expect(outOfRange).toEqual({ before_start: 1, after_cutoff: 9 });
    expect(fake.calls.filter(c => c.method === 'countDocuments')).toHaveLength(0);
    expect(events.some(e => e.type === 'warn' && e.message.includes('no window'))).toBe(true);

    // Resumed without the rest chunk, a collection with no ObjectId ids has nothing to export: a
    // fatal config error, not an empty `complete` batch.
    await expect(
      planChunks(
        ctx,
        deps,
        batch([{ ...plan, rest: false }], {
          resumed: true,
          outOfRange: { orders: { before_start: 1, after_cutoff: 9 } },
        }),
        cc({ name: 'orders', strategy: 'objectid-window' })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('no document has an ObjectId _id'),
    });
  });
});
