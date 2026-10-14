import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import exportArchive from '#export/exportArchive';
import acquireLock from '#runtime/acquireLock';
import msmError from '#runtime/msmError';
import type { ExportOptions, MsmEvent } from '#types';
import { exampleConfig, memoryContext, tmpDir } from '../../helpers.js';
import { fakeCollection, fakeMongo } from './fakeMongo.js';
import type { FakeCollectionSpec } from './fakeMongo.js';

const now = new Date('2026-10-13T02:03:04Z');

const oid = (iso: string, i: number) =>
  new ObjectId(
    `${Math.floor(new Date(iso).getTime() / 1000)
      .toString(16)
      .padStart(8, '0')}00000000${String(i).padStart(8, '0')}`
  );

const auditDocs: Document[] = [
  { _id: oid('2026-10-12T22:10:00Z', 1), created_at: new Date('2026-10-12T22:10:00Z') },
  { _id: oid('2026-10-12T23:10:00Z', 2), created_at: new Date('2026-10-12T23:10:00Z') },
];

/**
 * The window filter counts the two documents; the rest filter (an `$or`) and the out-of-range
 * counts see none.
 */
const windowCount = (f: Document): number => {
  const text = JSON.stringify(f);

  return text.includes('$lt') && !text.includes('$or') ? 2 : 0;
};

/**
 * Two collections: audit_log (day windows over one day, cursor) and coupons (keyset full
 * collection).
 */
function specs(
  over: Partial<Record<'audit_log' | 'coupons', Partial<FakeCollectionSpec>>> = {}
): FakeCollectionSpec[] {
  return [
    {
      name: 'audit_log',
      docs: auditDocs,
      indexes: [{ name: 'created_at_1', key: { created_at: 1 } }],
      bounds: { min: auditDocs[0]!.created_at as Date, max: auditDocs[1]!.created_at as Date },
      estimated: 2,
      counts: windowCount,
      ...over.audit_log,
    },
    {
      name: 'coupons',
      docs: [{ _id: 'SPRING10' }],
      pages: [[{ _id: 'SPRING10' }], [], [], [], [], [], [], []],
      ...over.coupons,
    },
  ];
}

async function setup(
  options: { collections?: FakeCollectionSpec[]; signal?: AbortSignal; stateDir?: string } = {}
) {
  const stateDir = options.stateDir ?? (await tmpDir());

  const config = exampleConfig({
    stateDir,
    minFreeDiskMb: 0,
    retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    export: {
      batchPrefix: 'app-archive',
      concurrency: 2,
      partMaxBytesMb: 1,
      keysetPageDocs: 100,
      chunkAttempts: 2,
      notes: 'unit',
    },
    collections: [
      {
        name: 'audit_log',
        strategy: 'timestamp-window',
        field: 'created_at',
        window: 'day',
        rest: 'export',
      },
      { name: 'coupons', strategy: 'full-collection' },
    ],
  });

  const mc = memoryContext({ config, signal: options.signal, now: () => now });
  const fakes = (options.collections ?? specs()).map(fakeCollection);
  const mongo = fakeMongo(fakes);
  const asked: string[] = [];

  const opts = (over: Partial<ExportOptions> = {}): ExportOptions => ({
    ctx: mc.ctx,
    mongo,
    store: mc.store,
    collections: config.collections,
    cutoff: '2026-10-13T00:00:00Z',
    confirm: async q => {
      asked.push(q);
    },
    ...over,
  });

  const batchManifest = () =>
    JSON.parse(
      mc.store.objects
        .get(mc.layout.batchManifest('app-archive-full-20261013T020304Z'))
        ?.toString('utf8') ?? 'null'
    ) as Record<string, unknown> | null;

  const messages = (type: 'info' | 'warn') =>
    mc.events.flatMap((e: MsmEvent) => (e.type === type ? [e.message] : []));

  const warnings = () => messages('warn');

  return { ...mc, mongo, fakes, asked, opts, stateDir, batchManifest, warnings, messages };
}

const expectedRunIds = [
  'app-archive-full-20261013T020304Z-audit_log-timestamp-window-20261012T000000Z-20261013T000000Z',
  'app-archive-full-20261013T020304Z-audit_log-full-collection-rest',
  'app-archive-full-20261013T020304Z-coupons-full-collection-full',
];

describe('exportArchive', () => {
  it('dry run plans, connects, writes nothing and exits 0', async () => {
    const { store, asked, opts, messages } = await setup();
    const result = await exportArchive(opts({ dryRun: true }));

    expect(result).toMatchObject({
      batchId: 'app-archive-full-20261013T020304Z',
      status: 'planned',
      outcomes: [],
      exitCode: 0,
    });

    expect(result.perCollection).toEqual([
      { collection: 'audit_log', planned: 2, done: 0, flagged: 0, failed: 0, docs: 0 },
      { collection: 'coupons', planned: 1, done: 0, flagged: 0, failed: 0, docs: 0 },
    ]);

    expect(store.objects.size).toBe(0);
    expect(asked).toEqual([]);

    expect(messages('info')).toEqual(
      expect.arrayContaining(expectedRunIds.map(r => `pending ${r}`))
    );
  });

  it('exports every chunk, batch manifest goes running then complete, caches commits', async () => {
    const { store, layout, asked, opts, batchManifest, stateDir } = await setup();
    const result = await exportArchive(opts());

    expect(asked).toEqual([
      'Export 3 chunks (3 pending) of 2 collections from app to ' +
        's3://example-archive-bucket/mongo-archive as batch ' +
        'app-archive-full-20261013T020304Z?',
    ]);

    expect(result).toMatchObject({ status: 'complete', exitCode: 0 });

    expect(result.outcomes.map(o => [o.chunk, o.status, o.docs])).toEqual(
      expect.arrayContaining([
        [expectedRunIds[0], 'done', 2],
        [expectedRunIds[1], 'done', 0],
        [expectedRunIds[2], 'done', 1],
      ])
    );

    expect(result.perCollection).toEqual([
      { collection: 'audit_log', planned: 2, done: 2, flagged: 0, failed: 0, docs: 2 },
      { collection: 'coupons', planned: 1, done: 1, flagged: 0, failed: 0, docs: 1 },
    ]);

    const keys = [...store.objects.keys()].sort();

    expect(keys.filter(k => k.includes('/manifests/') && k.includes('collection='))).toEqual(
      expectedRunIds
        .map(r => layout.chunkManifest(r.includes('coupons') ? 'coupons' : 'audit_log', r))
        .sort()
    );

    const auditPart = layout.part(
      layout.rawPrefix(
        'audit_log',
        { start: new Date('2026-10-12T00:00:00Z'), end: new Date('2026-10-13T00:00:00Z') },
        expectedRunIds[0]!
      ),
      1
    );

    const couponsPart = layout.part(layout.rawPrefix('coupons', null, expectedRunIds[2]!), 1);

    expect(keys.filter(k => k.includes('/raw/'))).toEqual(
      [auditPart, `${auditPart}.sha256`, couponsPart, `${couponsPart}.sha256`].sort()
    );

    expect(batchManifest()).toMatchObject({
      status: 'complete',
      completed_chunks: 3,
      failed_chunks: 0,
      notes: 'unit',
      cutoff_utc: '2026-10-13T00:00:00Z',
      out_of_range: { audit_log: { before_start: 0, after_cutoff: 0 } },
      plan: { kind: 'full', include_rest: false },
    });

    expect(typeof batchManifest()?.completed_at).toBe('string');

    const cache = await readFile(
      join(stateDir, 'export', 'app-archive-full-20261013T020304Z', 'completed.jsonl'),
      'utf8'
    );

    expect(cache.trimEnd().split('\n')).toHaveLength(3);
  });

  it('resumes a batch: skips committed chunks (cache or manifests), reruns flagged', async () => {
    const first = await setup();

    await exportArchive(first.opts());

    const again = await setup({ stateDir: first.stateDir });

    for (const [k, v] of first.store.objects) again.store.objects.set(k, v);

    const result = await exportArchive(
      again.opts({ batchId: 'app-archive-full-20261013T020304Z', cutoff: undefined })
    );

    expect(result).toMatchObject({ status: 'complete', exitCode: 0, outcomes: [] });
    expect(result.perCollection.map(c => c.done)).toEqual([2, 1]);
    expect(again.asked).toEqual([]);

    // Without the cache the manifests on S3 decide; a flagged manifest is pending again and
    // rewritten in place.
    const third = await setup();

    for (const [k, v] of first.store.objects) third.store.objects.set(k, v);

    const flaggedKey = third.layout.chunkManifest('audit_log', expectedRunIds[1]!);

    const flagged = JSON.parse(third.store.objects.get(flaggedKey)!.toString('utf8')) as Record<
      string,
      unknown
    >;

    third.store.objects.set(
      flaggedKey,
      Buffer.from(JSON.stringify({ ...flagged, counts_match: false }))
    );

    const rerun = await exportArchive(
      third.opts({ batchId: 'app-archive-full-20261013T020304Z', cutoff: undefined })
    );

    expect(third.asked[0]).toContain('Export 3 chunks (1 pending)');
    expect(rerun.outcomes.map(o => o.chunk)).toEqual([expectedRunIds[1]]);
    expect(rerun.status).toBe('complete');
  });

  it('refuses --since on an existing full batch and a changed --cutoff', async () => {
    const first = await setup();

    await exportArchive(first.opts());

    await expect(
      exportArchive(first.opts({ batchId: 'app-archive-full-20261013T020304Z', since: 'last' }))
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('--since only applies to a delta'),
    });

    await expect(
      exportArchive(
        first.opts({ batchId: 'app-archive-full-20261013T020304Z', cutoff: '2026-10-12T00:00:00Z' })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('does not match the frozen plan'),
    });
  });

  it('a signal after the last commit leaves the batch complete for --since last', async () => {
    const controller = new AbortController();
    const s = await setup({ signal: controller.signal });
    let manifests = 0;
    const putText = s.store.putText.bind(s.store);

    s.store.putText = async (key, body, type) => {
      const sha = await putText(key, body, type);

      // The third chunk manifest is the last one; the signal arrives while its records are being
      // written.
      if (key.includes('collection=') && key.includes('/manifests/')) {
        manifests += 1;

        if (manifests === 3) controller.abort('SIGTERM');
      }

      return sha;
    };

    const result = await exportArchive(s.opts());

    expect(result).toMatchObject({ status: 'complete', exitCode: 143 });

    expect(s.batchManifest()).toMatchObject({
      status: 'complete',
      completed_chunks: 3,
      failed_chunks: 0,
    });
  });

  it('a manifest copy nested deeper under the prefix is not committed on resume', async () => {
    const first = await setup();

    await exportArchive(first.opts());

    const again = await setup();
    const canonical = again.layout.chunkManifest('coupons', expectedRunIds[2]!);

    for (const [k, v] of first.store.objects) if (k !== canonical) again.store.objects.set(k, v);

    again.store.objects.set(
      `${canonical.slice(0, -'.json'.length)}-copy/run_id=${expectedRunIds[2]}.json`,
      first.store.objects.get(canonical)!
    );

    const result = await exportArchive(
      again.opts({ batchId: 'app-archive-full-20261013T020304Z', cutoff: undefined })
    );

    expect(result.outcomes.map(o => o.chunk)).toEqual([expectedRunIds[2]]);
    expect(result.status).toBe('complete');
  });

  it('returns incomplete with a partial batch manifest on a flagged or failed chunk', async () => {
    // The window cursor dies on every attempt (failed); the rest chunk counts 2 but reads nothing
    // (mismatch).
    const { opts, batchManifest, warnings } = await setup({
      collections: specs({ audit_log: { counts: () => 2, failAfter: 1 } }),
    });

    const result = await exportArchive(opts());

    expect(result).toMatchObject({ status: 'partial', exitCode: 2 });

    const audit = result.outcomes.filter(o => o.collection === 'audit_log');

    expect(audit.map(o => o.status).sort()).toEqual(['failed', 'mismatch']);

    expect(result.perCollection[0]).toMatchObject({
      collection: 'audit_log',
      planned: 2,
      done: 0,
      flagged: 1,
      failed: 1,
    });

    expect(batchManifest()).toMatchObject({
      status: 'partial',
      completed_chunks: 1,
      failed_chunks: 2,
    });

    expect(warnings().some(w => w.includes('failed (unknown)'))).toBe(true);
  });

  it('flags a count mismatch after the last attempt and exits 2', async () => {
    const { opts, batchManifest } = await setup({
      collections: specs({ coupons: { counts: [1, 2, 1, 2] } }),
    });

    const result = await exportArchive(
      opts({
        collections: [
          { name: 'coupons', strategy: 'full-collection', window: 'day', rest: 'auto' },
        ],
      })
    );

    expect(result).toMatchObject({ status: 'partial', exitCode: 2 });
    expect(result.outcomes[0]).toMatchObject({ status: 'mismatch', code: 'count_mismatch' });
    expect(result.perCollection[0]).toMatchObject({ flagged: 1, done: 0 });

    expect(batchManifest()).toMatchObject({
      status: 'partial',
      completed_chunks: 0,
      failed_chunks: 1,
    });
  });

  it('stops between documents on SIGINT: batch interrupted, exit 130 (SIGTERM 143)', async () => {
    const run = async (reason: 'SIGINT' | 'SIGTERM') => {
      const controller = new AbortController();

      const many = Array.from({ length: 40 }, (_, i) => ({
        _id: oid('2026-10-12T22:10:00Z', i),
        created_at: new Date('2026-10-12T22:10:00Z'),
      }));

      // The window must count something, or the chunk reads nothing and the abort never lands
      // mid-stream.
      const s = await setup({
        signal: controller.signal,
        collections: specs({
          audit_log: {
            docs: many,
            counts: filter => (JSON.stringify(filter).includes('$lt') ? many.length : 0),
            onDoc: i => {
              if (i === 10) controller.abort(reason);
            },
          },
        }),
      });

      const result = await exportArchive(
        s.opts({ collections: [{ ...s.config.collections[0]!, rest: 'skip' }] })
      );

      return { result, s };
    };

    const { result, s } = await run('SIGINT');

    expect(result).toMatchObject({ status: 'interrupted', exitCode: 130 });
    expect(result.outcomes.map(o => o.status)).toEqual(['interrupted']);
    expect(result.perCollection[0]).toMatchObject({ planned: 1, done: 0, failed: 1 });
    expect(s.batchManifest()).toMatchObject({ status: 'interrupted' });

    expect([...s.store.objects.keys()].some(k => k.includes('collection=audit_log/run_id='))).toBe(
      false
    );

    expect((await run('SIGTERM')).result.exitCode).toBe(143);
  });

  it('a fatal error stops the other chunks, marks the batch failed and rethrows', async () => {
    const fatal = msmError('s3', 'AccessDenied', { fatal: true });
    const { opts, batchManifest, store } = await setup();
    const putFile = store.putFile.bind(store);

    store.putFile = async (key, path, o) => {
      if (key.includes('coupons')) throw fatal;

      return putFile(key, path, o);
    };

    await expect(exportArchive(opts())).rejects.toBe(fatal);
    expect(batchManifest()).toMatchObject({ status: 'failed' });
  });

  it('respects the export lock and a declined prompt', async () => {
    const { opts, stateDir, store } = await setup();
    const release = await acquireLock(stateDir, 'export', false);

    await expect(exportArchive(opts())).rejects.toMatchObject({ msmCode: 'lock' });
    await release();

    await expect(
      exportArchive(
        opts({
          confirm: async () => {
            throw new Error('aborted');
          },
        })
      )
    ).rejects.toThrow('aborted');

    expect(store.objects.size).toBe(0);

    await expect(exportArchive(opts({ forceUnlock: true }))).resolves.toMatchObject({
      status: 'complete',
    });
  });

  it('a flagged chunk is pending again on resume, and the batch then completes', async () => {
    const first = await setup({ collections: specs({ coupons: { counts: [1, 2, 1, 2] } }) });
    const flagged = await exportArchive(first.opts());

    expect(flagged).toMatchObject({ status: 'partial', exitCode: 2 });

    expect(flagged.outcomes.find(o => o.collection === 'coupons')).toMatchObject({
      status: 'mismatch',
    });

    // The cache must not hold the flagged chunk: only committed manifests are cached.
    const cache = await readFile(
      join(first.stateDir, 'export', 'app-archive-full-20261013T020304Z', 'completed.jsonl'),
      'utf8'
    );

    expect(cache).not.toContain('coupons');

    const again = await setup({ stateDir: first.stateDir });

    for (const [k, v] of first.store.objects) again.store.objects.set(k, v);

    const result = await exportArchive(
      again.opts({ batchId: 'app-archive-full-20261013T020304Z', cutoff: undefined })
    );

    expect(again.asked[0]).toContain('Export 3 chunks (1 pending)');
    expect(result.outcomes.map(o => [o.chunk, o.status])).toEqual([[expectedRunIds[2], 'done']]);
    expect(result).toMatchObject({ status: 'complete', exitCode: 0 });

    expect(again.batchManifest()).toMatchObject({
      status: 'complete',
      completed_chunks: 3,
      failed_chunks: 0,
    });
  });

  it('a -C resume runs only selected pending chunks, tallies the whole frozen plan', async () => {
    const first = await setup({
      collections: specs({ audit_log: { counts: () => 2, failAfter: 1 } }),
    });

    expect((await exportArchive(first.opts())).status).toBe('partial');

    const again = await setup({
      stateDir: first.stateDir,
      collections: specs({ audit_log: { counts: () => 2, failAfter: 1 } }),
    });

    for (const [k, v] of first.store.objects) again.store.objects.set(k, v);

    const result = await exportArchive(
      again.opts({
        batchId: 'app-archive-full-20261013T020304Z',
        cutoff: undefined,
        collections: again.config.collections.filter(c => c.name === 'coupons'),
      })
    );

    expect(result).toMatchObject({ status: 'partial', exitCode: 2, outcomes: [] });

    expect(result.perCollection).toEqual([
      { collection: 'audit_log', planned: 2, done: 0, flagged: 0, failed: 0, docs: 0 },
      { collection: 'coupons', planned: 1, done: 1, flagged: 0, failed: 0, docs: 0 },
    ]);

    expect(again.batchManifest()).toMatchObject({
      status: 'partial',
      completed_chunks: 1,
      failed_chunks: 2,
    });

    expect(again.messages('info')).toContainEqual(
      expect.stringContaining('2 pending chunks of unselected collections (audit_log)')
    );

    // A collection the frozen plan does not know cannot be added on resume.
    await expect(
      exportArchive(
        again.opts({
          batchId: 'app-archive-full-20261013T020304Z',
          cutoff: undefined,
          collections: [
            { name: 'orders', strategy: 'full-collection', window: 'day', rest: 'auto' },
          ],
        })
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('not in the plan'),
    });
  });

  it('the cache never stands in for S3: a cleaned prefix plans everything again', async () => {
    const first = await setup();

    expect((await exportArchive(first.opts({ batchId: 'nightly' }))).status).toBe('complete');

    const again = await setup({ stateDir: first.stateDir });
    const result = await exportArchive(again.opts({ batchId: 'nightly' }));

    expect(again.asked).toEqual([expect.stringContaining('Export 3 chunks (3 pending)')]);
    expect(result.outcomes).toHaveLength(3);
    expect(result.status).toBe('complete');
  });

  it('an interrupt before the chunk phase returns the signal exit code, not a throw', async () => {
    const controller = new AbortController();
    const { opts, store } = await setup({ signal: controller.signal });

    controller.abort('SIGTERM');

    const result = await exportArchive(opts());

    expect(result).toMatchObject({ status: 'interrupted', exitCode: 143, outcomes: [] });
    expect(store.objects.size).toBe(0);
  });

  it('refuses an empty collection list instead of writing an empty complete batch', async () => {
    const { opts, store } = await setup();

    await expect(exportArchive(opts({ collections: [] }))).rejects.toMatchObject({
      msmCode: 'config',
      message: expect.stringContaining('no collections to export'),
    });

    expect(store.objects.size).toBe(0);
  });
});
