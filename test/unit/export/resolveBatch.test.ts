import { describe, expect, it } from 'vitest';
import createExportLedger from '#export/createExportLedger';
import resolveBatch from '#export/resolveBatch';
import type { ExportDeps, ExportOptions } from '#types';
import { exampleConfig, memoryContext, realShape } from '../../helpers.js';
import { fakeCollection, fakeMongo } from './fakeMongo.js';

const now = new Date('2026-10-13T02:03:04Z');

function setup(
  options: {
    estimated?: Record<string, number>;
    config?: ReturnType<typeof exampleConfig>;
    now?: Date;
  } = {}
) {
  const mc = memoryContext({ now: () => options.now ?? now, config: options.config });

  const mongo = fakeMongo(
    Object.entries(options.estimated ?? {}).map(([name, estimated]) =>
      fakeCollection({ name, estimated })
    )
  );

  const deps: ExportDeps = {
    mongo,
    store: mc.store,
    layout: mc.layout,
    ledger: createExportLedger('/nowhere', 'x'),
  };

  const opts = (over: Partial<ExportOptions> = {}): ExportOptions => ({
    ctx: mc.ctx,
    mongo,
    store: mc.store,
    collections: mc.config.collections,
    ...over,
  });

  return { ...mc, mongo, deps, opts };
}

/**
 * A batch without a plan proves it archived a collection through its chunk manifests; the listing
 * only needs the keys.
 */
async function covered(
  store: ReturnType<typeof setup>['store'],
  layout: ReturnType<typeof setup>['layout'],
  runId: string,
  names: string[]
): Promise<void> {
  for (const name of names)
    await store.putText(
      layout.chunkManifest(name, `${runId}-${name}-full-collection-full`),
      '{}',
      'application/json'
    );
}

describe('resolveBatch', () => {
  it('starts a full batch with the generated id, lagged hour-floored cutoff and plan', async () => {
    const { ctx, deps, opts, events } = setup({ estimated: { audit_log: 10, orders: 5_000_000 } });
    const batch = await resolveBatch(ctx, deps, opts());

    expect(batch).toMatchObject({
      batchId: 'app-archive-full-20261013T020304Z',
      kind: 'full',
      since: null,
      startedAt: now,
      includeRest: false,
      resumed: false,
      outOfRange: {},
    });

    expect(batch.cutoff.toISOString()).toBe('2026-10-13T01:00:00.000Z');

    expect(batch.collections).toEqual([
      {
        collection: 'audit_log',
        mode: 'timestamp-window',
        field: 'created_at',
        window: 'day',
        start_utc: null,
        rest: true,
      },
      {
        collection: 'orders',
        mode: 'objectid-window',
        field: null,
        window: 'day',
        start_utc: null,
        rest: false,
      },
      {
        collection: 'coupons',
        mode: 'full-collection',
        field: null,
        window: null,
        start_utc: null,
        rest: false,
      },
    ]);

    expect(
      events.filter(e => e.type === 'warn').map(e => (e as { message: string }).message)
    ).toEqual([expect.stringContaining('orders: rest chunk skipped (rest: auto')]);
  });

  it('honours rest: export, rest: skip, --include-rest, and skips the rest in deltas', async () => {
    const config = exampleConfig({
      collections: [
        { name: 'a', strategy: 'timestamp-window', field: 'created_at', rest: 'export' },
        { name: 'b', strategy: 'objectid-window', rest: 'skip' },
      ],
    });

    const { ctx, deps, opts } = setup({ config, estimated: { a: 5_000_000, b: 1 } });

    expect((await resolveBatch(ctx, deps, opts())).collections.map(c => c.rest)).toEqual([
      true,
      false,
    ]);

    expect(
      (await resolveBatch(ctx, deps, opts({ includeRest: true }))).collections.map(c => c.rest)
    ).toEqual([true, true]);

    const delta = await resolveBatch(ctx, deps, opts({ since: '2026-10-12T00:00:00Z' }));

    expect(delta.collections.map(c => c.rest)).toEqual([false, false]);
    expect(delta.kind).toBe('delta');
    expect(delta.batchId).toBe('app-archive-delta-20261013T020304Z');
  });

  it('sets a delta start to max(configured start, since) and accepts --cutoff', async () => {
    const config = exampleConfig({
      collections: [
        {
          name: 'a',
          strategy: 'timestamp-window',
          field: 'created_at',
          start: '2026-10-12T06:00:00Z',
        },
        { name: 'b', strategy: 'objectid-window', start: '2026-10-01T00:00:00Z' },
      ],
    });

    const { ctx, deps, opts } = setup({ config, estimated: { a: 1, b: 1 } });

    const batch = await resolveBatch(
      ctx,
      deps,
      opts({ since: '2026-10-12T00:00:00Z', cutoff: '2026-10-13T00:00:00Z' })
    );

    expect(batch.collections.map(c => c.start_utc)).toEqual([
      '2026-10-12T06:00:00Z',
      '2026-10-12T00:00:00Z',
    ]);

    expect(batch.cutoff.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect(batch.since?.toISOString()).toBe('2026-10-12T00:00:00.000Z');

    const full = await resolveBatch(ctx, deps, opts());

    expect(full.collections.map(c => c.start_utc)).toEqual([
      '2026-10-12T06:00:00Z',
      '2026-10-01T00:00:00Z',
    ]);
  });

  it('--since last takes the newest complete batch, tool or foreign, minus overlap', async () => {
    const { ctx, deps, opts, store, layout } = setup({
      estimated: { audit_log: 1, orders: 1 },
      now: new Date('2026-10-18T02:03:04Z'),
    });

    await expect(resolveBatch(ctx, deps, opts({ since: 'last' }))).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('no complete batch'),
    });

    const foreign = (await realShape('batch-full.json')) as Record<string, unknown>;

    await store.putText(
      layout.batchManifest(foreign.run_id as string),
      JSON.stringify(foreign),
      'application/json'
    );

    await covered(store, layout, foreign.run_id as string, ['audit_log', 'orders']);

    const partial = {
      ...foreign,
      run_id: 'app-archive-full-20261014T010000Z',
      cutoff_utc: '2026-10-14T00:00:00Z',
      status: 'partial',
      failed_chunks: 1,
    };

    await store.putText(
      layout.batchManifest(partial.run_id),
      JSON.stringify(partial),
      'application/json'
    );

    await covered(store, layout, partial.run_id, ['audit_log', 'orders']);

    const unfinished = {
      ...foreign,
      run_id: 'app-archive-full-20261015T010000Z',
      cutoff_utc: '2026-10-15T00:00:00Z',
      completed_at: null,
    };

    await store.putText(
      layout.batchManifest(unfinished.run_id),
      JSON.stringify(unfinished),
      'application/json'
    );

    await covered(store, layout, unfinished.run_id, ['audit_log', 'orders']);

    const batch = await resolveBatch(
      ctx,
      deps,
      opts({ since: 'last', cutoff: '2026-10-16T00:00:00Z' })
    );

    expect(batch.since?.toISOString()).toBe('2026-10-13T00:00:00.000Z');

    const tool = {
      ...foreign,
      run_id: 'app-archive-delta-20261016T010000Z',
      cutoff_utc: '2026-10-16T00:00:00Z',
      status: 'complete',
    };

    await store.putText(
      layout.batchManifest(tool.run_id),
      JSON.stringify(tool),
      'application/json'
    );

    await covered(store, layout, tool.run_id, ['audit_log', 'orders']);

    expect(
      (
        await resolveBatch(ctx, deps, opts({ since: 'last', cutoff: '2026-10-17T00:00:00Z' }))
      ).since?.toISOString()
    ).toBe('2026-10-15T23:00:00.000Z');
  });

  it('a batch without a plan covers only collections the archive shows it exported', async () => {
    const config = exampleConfig({
      collections: [
        { name: 'audit_log', strategy: 'timestamp-window', field: 'created_at' },
        { name: 'neworders', strategy: 'objectid-window' },
      ],
    });

    const { ctx, deps, opts, store, layout, events } = setup({
      config,
      estimated: { audit_log: 1, neworders: 1 },
      now: new Date('2026-10-18T02:03:04Z'),
    });

    const foreign = (await realShape('batch-full.json')) as Record<string, unknown>;

    await store.putText(
      layout.batchManifest(foreign.run_id as string),
      JSON.stringify(foreign),
      'application/json'
    );

    await covered(store, layout, foreign.run_id as string, ['audit_log']);

    // A manifest copy nested deeper under the prefix, or a key whose run id does not parse, is not
    // a chunk of this batch.
    const nestedKey =
      layout.chunkManifestPrefix('neworders', foreign.run_id as string) +
      `nested/run_id=${foreign.run_id as string}-neworders-full-collection-full.json`;

    await store.putText(nestedKey, '{}', 'application/json');

    await store.putText(
      layout.chunkManifest('neworders', `${foreign.run_id as string}-neworders-garbage`),
      '{}',
      'application/json'
    );

    // neworders was never archived: continuing the archive and adding it to the config must not
    // skip its history.
    await expect(
      resolveBatch(ctx, deps, opts({ since: 'last', cutoff: '2026-10-17T00:00:00Z' }))
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('no complete batch covers neworders'),
    });

    expect(
      events.filter(e => e.type === 'info').map(e => (e as { message: string }).message)
    ).toEqual([expect.stringContaining(`audit_log: delta from ${foreign.run_id as string}`)]);

    // A foreign delta names its collections in collection_start_utc, which counts as coverage
    // without any listing.
    const delta = (await realShape('batch-delta.json')) as Record<string, unknown>;

    const named = {
      ...delta,
      run_id: 'app-archive-delta-20261016T010000Z',
      cutoff_utc: '2026-10-16T00:00:00Z',
      collection_start_utc: { neworders: '2026-10-12T23:00:00Z' },
    };

    await store.putText(
      layout.batchManifest(named.run_id),
      JSON.stringify(named),
      'application/json'
    );

    const batch = await resolveBatch(
      ctx,
      deps,
      opts({ since: 'last', cutoff: '2026-10-17T00:00:00Z' })
    );

    expect(batch.collections.map(c => [c.collection, c.start_utc])).toEqual([
      ['audit_log', '2026-10-13T00:00:00Z'],
      ['neworders', '2026-10-15T23:00:00Z'],
    ]);
  });

  it('--since last resolves per collection to the newest complete batch covering it', async () => {
    const { ctx, deps, opts, store, layout, events } = setup({
      estimated: { audit_log: 1, orders: 1 },
      now: new Date('2026-10-18T02:03:04Z'),
    });

    const foreign = (await realShape('batch-full.json')) as Record<string, unknown>;

    // The foreign batch (no plan) archived both collections; the later tool batch only exported
    // audit_log.
    await store.putText(
      layout.batchManifest(foreign.run_id as string),
      JSON.stringify(foreign),
      'application/json'
    );

    await covered(store, layout, foreign.run_id as string, ['audit_log', 'orders']);

    const audit = {
      ...foreign,
      run_id: 'app-archive-delta-20261016T010000Z',
      cutoff_utc: '2026-10-16T00:00:00Z',
      status: 'complete',
      started_at: '2026-10-16T01:00:00+00:00',
      plan: {
        kind: 'delta',
        include_rest: false,
        collections: [
          {
            collection: 'audit_log',
            mode: 'timestamp-window',
            field: 'created_at',
            window: 'day',
            start_utc: '2026-10-12T23:00:00Z',
            rest: false,
          },
        ],
      },
    };

    await store.putText(
      layout.batchManifest(audit.run_id),
      JSON.stringify(audit),
      'application/json'
    );

    const batch = await resolveBatch(
      ctx,
      deps,
      opts({ since: 'last', cutoff: '2026-10-17T00:00:00Z' })
    );

    expect(batch.collections.map(c => [c.collection, c.start_utc])).toEqual([
      ['audit_log', '2026-10-15T23:00:00Z'],
      ['orders', '2026-10-13T00:00:00Z'],
      ['coupons', null],
    ]);

    expect(batch.since?.toISOString()).toBe('2026-10-13T00:00:00.000Z');

    expect(
      events.filter(e => e.type === 'info').map(e => (e as { message: string }).message)
    ).toEqual([
      expect.stringContaining('audit_log: delta from app-archive-delta-20261016T010000Z'),
      expect.stringContaining(`orders: delta from ${foreign.run_id as string}`),
    ]);

    // With no batch covering a collection there is no safe delta start for it.
    const onlyAudit = setup({ estimated: { audit_log: 1, orders: 1 } });

    await onlyAudit.store.putText(
      onlyAudit.layout.batchManifest(audit.run_id),
      JSON.stringify(audit),
      'application/json'
    );

    await expect(
      resolveBatch(onlyAudit.ctx, onlyAudit.deps, onlyAudit.opts({ since: 'last' }))
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('no complete batch covers orders'),
    });
  });

  it('a frozen plan whose run_id is not the batch id asked for is refused', async () => {
    const { ctx, deps, opts, store, layout } = setup();

    const record = {
      run_id: '../../tmp/x',
      cutoff_utc: '2026-10-12T00:00:00Z',
      completed_chunks: 0,
      failed_chunks: 0,
      completed_at: null,
      status: 'running',
      started_at: '2026-10-12T01:00:00+00:00',
      plan: { kind: 'full', include_rest: false, collections: [] },
    };

    await store.putText(
      layout.batchManifest('fixed-id'),
      JSON.stringify(record),
      'application/json'
    );

    await expect(resolveBatch(ctx, deps, opts({ batchId: 'fixed-id' }))).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('carries run_id'),
    });
  });

  it('resumes from the frozen plan: --since last is a no-op, other flags must match', async () => {
    const { ctx, deps, opts, store, layout, events } = setup();

    const record = {
      run_id: 'fixed-id',
      cutoff_utc: '2026-10-12T00:00:00Z',
      completed_chunks: 1,
      failed_chunks: 2,
      completed_at: null,
      backup_mode: 'delta-windowed-with-full-small-collections',
      requested_start_utc: '2026-10-11T23:00:00Z',
      status: 'interrupted',
      started_at: '2026-10-12T01:00:00+00:00',
      out_of_range: { audit_log: { before_start: 0, after_cutoff: 3 } },
      plan: {
        kind: 'delta',
        include_rest: true,
        collections: [
          {
            collection: 'audit_log',
            mode: 'timestamp-window',
            field: 'created_at',
            window: 'hour',
            start_utc: '2026-10-11T23:00:00Z',
            rest: true,
          },
        ],
      },
    };

    await store.putText(
      layout.batchManifest('fixed-id'),
      JSON.stringify(record),
      'application/json'
    );

    const batch = await resolveBatch(ctx, deps, opts({ batchId: 'fixed-id', includeRest: false }));

    expect(batch).toMatchObject({
      batchId: 'fixed-id',
      kind: 'delta',
      includeRest: true,
      resumed: true,
      outOfRange: { audit_log: { before_start: 0, after_cutoff: 3 } },
    });

    expect(batch.cutoff.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(batch.since?.toISOString()).toBe('2026-10-11T23:00:00.000Z');
    expect(batch.startedAt.toISOString()).toBe('2026-10-12T01:00:00.000Z');
    expect(batch.collections).toEqual(record.plan.collections);

    // A unit file that started the delta with --since last restarts with the same line: accepted
    // with an info line.
    const again = await resolveBatch(ctx, deps, opts({ batchId: 'fixed-id', since: 'last' }));

    expect(again.resumed).toBe(true);

    expect(
      events.filter(e => e.type === 'info').map(e => (e as { message: string }).message)
    ).toContain('batch fixed-id exists; --since last is ignored in favour of its frozen plan');

    expect(
      (
        await resolveBatch(
          ctx,
          deps,
          opts({
            batchId: 'fixed-id',
            since: '2026-10-11T23:00:00Z',
            cutoff: '2026-10-12T00:00:00Z',
          })
        )
      ).resumed
    ).toBe(true);

    await expect(
      resolveBatch(ctx, deps, opts({ batchId: 'fixed-id', since: '2026-10-10T00:00:00Z' }))
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('does not match the frozen plan'),
    });

    await expect(
      resolveBatch(ctx, deps, opts({ batchId: 'fixed-id', cutoff: '2026-10-13T00:00:00Z' }))
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining(
        '--cutoff 2026-10-13T00:00:00Z does not match the frozen plan'
      ),
    });
  });

  it('refuses a cutoff in the future and warns about one inside the safety lag', async () => {
    const { ctx, deps, opts, events } = setup({ estimated: { audit_log: 1, orders: 1 } });

    await expect(
      resolveBatch(ctx, deps, opts({ cutoff: '2026-10-13T03:00:00Z' }))
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message:
        '--cutoff 2026-10-13T03:00:00Z is in the future; the next --since last ' +
        'would skip what is written until then',
    });

    const recent = await resolveBatch(ctx, deps, opts({ cutoff: '2026-10-13T02:00:00Z' }));

    expect(recent.cutoff.toISOString()).toBe('2026-10-13T02:00:00.000Z');

    expect(
      events.filter(e => e.type === 'warn').map(e => (e as { message: string }).message)
    ).toContain(
      '--cutoff 2026-10-13T02:00:00Z is inside the 60 minute safety lag; documents ' +
        'still being written may be missed'
    );
  });

  it('starts a new batch under an unknown --batch-id, rejects a foreign or bad id', async () => {
    const { ctx, deps, opts, store, layout } = setup({ estimated: { audit_log: 1, orders: 1 } });

    const fresh = await resolveBatch(
      ctx,
      deps,
      opts({ batchId: 'nightly.2026-10', cutoff: '2026-10-13T00:00:00Z' })
    );

    expect(fresh).toMatchObject({ batchId: 'nightly.2026-10', kind: 'full', resumed: false });

    const foreign = (await realShape('batch-full.json')) as Record<string, unknown>;

    await store.putText(
      layout.batchManifest(foreign.run_id as string),
      JSON.stringify(foreign),
      'application/json'
    );

    await expect(
      resolveBatch(ctx, deps, opts({ batchId: foreign.run_id as string }))
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('was not written by this tool'),
    });

    await expect(resolveBatch(ctx, deps, opts({ batchId: '-bad' }))).rejects.toMatchObject({
      msmCode: 'config',
    });
  });

  it('rejects a missing strategy, a bad instant and a since not before the cutoff', async () => {
    const config = exampleConfig({ collections: [{ name: 'a' }] });
    const { ctx, deps, opts } = setup({ config });

    await expect(resolveBatch(ctx, deps, opts())).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('has no strategy'),
    });

    const ok = setup({ estimated: { audit_log: 1, orders: 1 } });

    await expect(
      resolveBatch(ok.ctx, ok.deps, ok.opts({ cutoff: 'yesterday' }))
    ).rejects.toMatchObject({ msmCode: 'config' });

    // Without an offset the instant would be read in the host zone; with a fraction it would differ
    // from the frozen second.
    await expect(
      resolveBatch(ok.ctx, ok.deps, ok.opts({ since: '2026-10-12T00:00:00' }))
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('with an offset at second precision'),
    });

    await expect(
      resolveBatch(ok.ctx, ok.deps, ok.opts({ since: '2026-10-12T00:00:00.500Z' }))
    ).rejects.toMatchObject({ msmCode: 'config' });

    expect(
      (
        await resolveBatch(ok.ctx, ok.deps, ok.opts({ since: '2026-10-12T08:00:00+08:00' }))
      ).since?.toISOString()
    ).toBe('2026-10-12T00:00:00.000Z');

    await expect(
      resolveBatch(ok.ctx, ok.deps, ok.opts({ since: '2026-10-13T01:00:00Z' }))
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('not before the cutoff'),
    });
  });
});
