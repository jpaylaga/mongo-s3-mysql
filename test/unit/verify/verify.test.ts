import { describe, expect, it } from 'vitest';
import acquireLock from '#runtime/acquireLock';
import toolVersion from '#runtime/toolVersion';
import type { CollectionConfig, MsmEvent, VerifyOptions } from '#types';
import verify from '#verify/verify';
import { exampleConfig, memoryContext, refusingStore, tmpDir } from '../../helpers.js';
import seedArchive, { lines, window } from './seedArchive.js';

const B = 'app-archive-full-20261013T020304Z';

const cc = (...names: string[]): CollectionConfig[] =>
  names.map(name => ({ name, window: 'day', rest: 'auto' }));

async function archive(options: { signal?: AbortSignal } = {}) {
  const config = exampleConfig({
    stateDir: await tmpDir(),
    retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    verify: { concurrency: 2 },
    collections: [],
  });

  const { ctx, store, layout, events } = memoryContext({
    command: 'verify',
    config,
    signal: options.signal,
    now: () => new Date('2026-10-13T03:00:00Z'),
  });

  const seed = seedArchive(store, layout);
  const a1 = await seed.chunk({ collection: 'audit_log', batchId: B, lines: lines(12) });

  const a2 = await seed.chunk({
    collection: 'audit_log',
    batchId: B,
    window: window('2026-03-03'),
    lines: lines(30, 13),
    partSize: 10,
    bom: 1,
  });

  const o1 = await seed.chunk({
    collection: 'orders',
    batchId: B,
    mode: 'objectid-window',
    lines: lines(5, 100),
  });

  const c1 = await seed.chunk({
    collection: 'coupons',
    batchId: B,
    mode: 'manifest-only',
    lines: [],
  });

  await seed.batch(B, 4);

  const asked: string[] = [];

  const run = (overrides: Partial<VerifyOptions> = {}) =>
    verify({
      ctx,
      store,
      collections: [],
      confirm: async q => {
        asked.push(q);
      },
      ...overrides,
    });

  return { ctx, config, store, layout, events, seed, chunks: { a1, a2, o1, c1 }, asked, run };
}

const kinds = (events: MsmEvent[], type: MsmEvent['type']) => events.filter(e => e.type === type);

describe('verify', () => {
  it('verifies every chunk of discovered collections, writes both records, exits 0', async () => {
    const { run, store, layout, events, asked, chunks } = await archive();
    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.missing).toEqual([]);

    expect(result.checks.map(c => c.runId).sort()).toEqual(
      Object.values(chunks)
        .map(c => c.runId)
        .sort()
    );

    expect(result.checks.every(c => c.ok)).toBe(true);

    // 5 parts (audit_log day 2 has three) plus their 5 sidecars; the byte total depends on zlib's
    // output.
    expect(asked).toEqual([
      expect.stringMatching(/^Read \d+ B in 10 objects to verify 4 chunks\?$/),
    ]);

    const parseCheck = JSON.parse(
      (await store.getText(layout.parseCheck('audit_log', chunks.a2.runId))) as string
    );

    expect(parseCheck).toMatchObject({
      ok: true,
      lines: 30,
      manifest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      tool: toolVersion,
    });

    const counts = JSON.parse(
      (await store.getText(layout.counts('orders', chunks.o1.runId))) as string
    );

    expect(counts).toMatchObject({ run_id: chunks.o1.runId, matches: true, verified_lines: 5 });

    expect(
      kinds(events, 'chunk').filter(e => e.type === 'chunk' && e.status === 'done')
    ).toHaveLength(4);

    expect(kinds(events, 'progress').at(-1)).toMatchObject({ done: 4, total: 4, docs: 47 });
  });

  it('skips chunks whose parse-check passed for the current manifest, unless --all', async () => {
    const { run, store, layout, asked, chunks } = await archive();

    await run();

    const second = await run();

    expect(second).toEqual({
      checks: [],
      skipped: 4,
      missing: [],
      invalidBatches: [],
      exitCode: 0,
    });

    expect(asked).toHaveLength(1);

    const all = await run({ all: true });

    expect(all.checks).toHaveLength(4);
    expect(all.skipped).toBe(0);

    // A rewritten manifest body (same meaning, new sha256) makes its chunk unverified again.
    const key = layout.chunkManifest('audit_log', chunks.a1.runId);

    await store.putText(key, `${await store.getText(key)}\n`, 'application/json');

    const third = await run();

    expect(third.checks.map(c => c.runId)).toEqual([chunks.a1.runId]);
    expect(third.skipped).toBe(3);
    expect(third.exitCode).toBe(0);
  });

  it('writes nothing with write: false; an unreadable parse-check is unverified', async () => {
    const { run, store, layout, chunks } = await archive();

    await store.putText(
      layout.parseCheck('orders', chunks.o1.runId),
      '{ broken',
      'application/json'
    );

    const before = new Map(store.objects);
    const result = await run({ write: false });

    expect(result.exitCode).toBe(0);
    expect(result.checks).toHaveLength(4);
    expect([...store.objects.keys()].sort()).toEqual([...before.keys()].sort());

    expect(store.objects.get(layout.parseCheck('orders', chunks.o1.runId))?.toString()).toBe(
      '{ broken'
    );
  });

  it('exits 3 for a damaged chunk and still writes its failing parse-check', async () => {
    const { run, store, layout, seed, events } = await archive();

    const bad = await seed.chunk({
      collection: 'orders',
      batchId: B,
      mode: 'full-collection',
      tail: 'rest',
      lines: lines(4, 200),
      manifest: { exported_count: 3, source_count: 3 },
    });

    await seed.batch(B, 5);

    const result = await run();

    expect(result.exitCode).toBe(3);

    const check = result.checks.find(c => c.runId === bad.runId);

    expect(check).toMatchObject({ ok: false, errors: ['4 lines, exported_count 3'] });

    expect(
      JSON.parse((await store.getText(layout.parseCheck('orders', bad.runId))) as string)
    ).toMatchObject({ ok: false, errors: ['4 lines, exported_count 3'] });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'chunk',
        chunk: bad.runId,
        status: 'mismatch',
        detail: '4 lines, exported_count 3',
      })
    );

    // It stays unverified, so the next run reads it again.
    const again = await run();

    expect(again.checks.map(c => c.runId)).toEqual([bad.runId]);
    expect(again.exitCode).toBe(3);
  });

  it('reports a batch whose completed_chunks exceed the manifests found as missing', async () => {
    const { run, seed, events } = await archive();

    await seed.batch(B, 5);

    const result = await run();

    expect(result.missing).toEqual([B]);
    expect(result.exitCode).toBe(3);

    expect(events).toContainEqual({
      type: 'warn',
      command: 'verify',
      message: `batch ${B}: 4 of 5 completed chunks have a manifest`,
    });

    // Flagged chunks do not count as completed.
    await seed.chunk({
      collection: 'orders',
      batchId: B,
      mode: 'full-collection',
      lines: lines(2, 300),
      manifest: { counts_match: false, source_count: 3 },
    });

    const again = await run({ all: true });

    expect(again.missing).toEqual([B]);
  });

  it('checks batch completeness over the whole archive, not the config; -C skips it', async () => {
    const { run, seed, events } = await archive();

    await seed.batch(B, 5);

    // A config that lists one of three archived collections: the parts of that one are read, every
    // collection is counted.
    const result = await run({ collections: cc('audit_log') });

    expect(result.checks.map(c => c.collection)).toEqual(['audit_log', 'audit_log']);
    expect(result.missing).toEqual([B]);
    expect(result.exitCode).toBe(3);

    const narrowed = await run({ collections: cc('audit_log'), narrowed: true });

    expect(narrowed.missing).toEqual([]);
    expect(narrowed.exitCode).toBe(0);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'info',
        message: expect.stringContaining('batch completeness not checked: -C'),
      })
    );

    const full = await run({ collections: cc('audit_log', 'orders', 'coupons', 'unknown') });

    expect(full.missing).toEqual([B]);
  });

  it('-C naming an unarchived collection is a config error, not an empty exit 0', async () => {
    const { run } = await archive();

    await expect(
      run({ collections: cc('audit_log', 'orderz'), narrowed: true })
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: '-C orderz: no such collection under s3://example-archive-bucket/mongo-archive',
    });

    // A configured collection that is not exported yet only matters under -C; the configured list
    // is a plan, not a selection.
    const result = await run({ collections: cc('audit_log', 'orderz') });

    expect(result.exitCode).toBe(0);
    expect(result.checks.map(c => c.collection)).toEqual(['audit_log', 'audit_log']);
  });

  it('an unparseable chunk manifest is one damaged chunk with a failing parse-check', async () => {
    const { run, store, layout, chunks } = await archive();
    const key = layout.chunkManifest('audit_log', chunks.a1.runId);
    const broken = JSON.parse((await store.getText(key)) as string) as Record<string, unknown>;

    delete broken.exported_count;
    await store.putText(key, JSON.stringify(broken), 'application/json');

    const countsKey = layout.counts('audit_log', chunks.a1.runId);

    await store.putText(
      countsKey,
      JSON.stringify({
        run_id: chunks.a1.runId,
        collection: 'audit_log',
        mode: 'timestamp-window',
        count_source: 'countDocuments',
        source_count: 12,
        exported_count: 12,
        matches: true,
      }),
      'application/json'
    );

    const result = await run();

    expect(result.exitCode).toBe(3);
    expect(result.checks).toHaveLength(4);

    const bad = result.checks.find(c => c.runId === chunks.a1.runId);

    // The zod detail names the field, so nobody has to download the manifest to find the problem.
    expect(bad).toMatchObject({
      ok: false,
      batchId: B,
      errors: [expect.stringMatching(/^record: .*invalid record; .*exported_count/)],
    });

    expect(bad?.counts).toBeUndefined();

    // The exporter's counts.json is the last copy of the chunk's counts: a record check leaves it
    // as it was.
    expect(JSON.parse((await store.getText(countsKey)) as string)).toMatchObject({
      source_count: 12,
      exported_count: 12,
      matches: true,
    });

    expect(
      result.checks
        .filter(c => c.ok)
        .map(c => c.runId)
        .sort()
    ).toEqual([chunks.a2.runId, chunks.c1.runId, chunks.o1.runId].sort());

    expect(
      JSON.parse((await store.getText(layout.parseCheck('audit_log', chunks.a1.runId))) as string)
    ).toMatchObject({
      ok: false,
      mode: 'timestamp-window',
      errors: [expect.stringMatching(/^record:/)],
    });

    // The damaged manifest does not count as a completed chunk either.
    expect(result.missing).toEqual([B]);
    // An unparseable batch manifest is reported on its own (export cannot resume it), never as a
    // batch with missing chunk manifests.
    await store.putText(layout.batchManifest(B), '{ "run_id": "x"', 'application/json');

    const batch = await run({ all: true });

    expect(batch.invalidBatches).toEqual([B]);
    expect(batch.missing).toEqual([]);
    expect(batch.exitCode).toBe(3);

    const requested = await run({ all: true, batchIds: [B] });

    expect(requested.invalidBatches).toEqual([B]);
    expect(requested.exitCode).toBe(3);
  });

  it('writes the failing parse-check of a damaged manifest only after confirmation', async () => {
    const { run, store, layout, chunks } = await archive();
    const key = layout.chunkManifest('audit_log', chunks.a1.runId);
    const before = await store.getText(layout.parseCheck('audit_log', chunks.a1.runId));

    await store.putText(key, '{ not json', 'application/json');

    await expect(
      run({
        confirm: async () => {
          throw new Error('aborted');
        },
      })
    ).rejects.toThrow('aborted');

    expect(await store.getText(layout.parseCheck('audit_log', chunks.a1.runId))).toBe(before);

    // With nothing left to read, the damaged record is still the one write the run would do, so it
    // asks first too.
    const verified = await archive();

    await verified.run();

    await verified.store.putText(
      verified.layout.chunkManifest('audit_log', verified.chunks.a1.runId),
      '{ not json',
      'application/json'
    );

    const asked: string[] = [];

    await verified.run({
      confirm: async q => {
        asked.push(q);
      },
    });

    expect(asked).toEqual([
      'Nothing to read; write a failing parse-check for 1 damaged manifests?',
    ]);

    expect(
      JSON.parse(
        (await verified.store.getText(
          verified.layout.parseCheck('audit_log', verified.chunks.a1.runId)
        )) as string
      )
    ).toMatchObject({ ok: false });
  });

  it('a --batch-id naming nothing under the prefix is a config error, not exit 0', async () => {
    const { run } = await archive();

    await expect(run({ batchIds: ['typo-batch'] })).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: expect.stringMatching(
        new RegExp(
          '^batch typo-batch not found under s3:\\/\\/example-archive-bucket\\/mongo-archive: ' +
            'no batch manifest and no chunk manifest$'
        )
      ),
    });
  });

  it('limits itself to --batch-id and warns about a batch without a manifest', async () => {
    const { run, seed, events } = await archive();
    const other = 'foreign-batch-2';

    await seed.chunk({
      collection: 'orders',
      batchId: other,
      mode: 'full-collection',
      lines: lines(2, 400),
    });

    const result = await run({ batchIds: [other] });

    expect(result.checks.map(c => c.runId)).toEqual([`${other}-orders-full-collection-full`]);
    expect(result.exitCode).toBe(0);

    expect(events).toContainEqual({
      type: 'warn',
      command: 'verify',
      message: `batch ${other} has no batch manifest; its completeness cannot be checked`,
    });

    const both = await run({ batchIds: [B, other], all: true });

    expect(both.checks).toHaveLength(5);
  });

  it('dry run reads no parts, asks nothing and exits 0', async () => {
    const { run, store, asked, events } = await archive();

    store.getStream = async () => {
      throw new Error('must not read');
    };

    const result = await run({ dryRun: true });

    expect(result).toEqual({
      checks: [],
      skipped: 0,
      missing: [],
      invalidBatches: [],
      exitCode: 0,
    });

    expect(asked).toEqual([]);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'info',
        message: expect.stringMatching(
          new RegExp(
            '^dry run: Read \\d+ B in 10 objects to verify 4 chunks; ' +
              '0 already verified, 1 batches, 3 collections$'
          )
        ),
      })
    );
  });

  it('asks nothing when every chunk is verified and propagates a declined prompt', async () => {
    const { run, asked } = await archive();

    await run();
    await run();
    expect(asked).toHaveLength(1);

    await expect(
      run({
        all: true,
        confirm: async () => {
          throw new Error('aborted');
        },
      })
    ).rejects.toThrow('aborted');
  });

  it('exits 2 when a chunk is unreadable after its attempts, recorded as operational', async () => {
    const { run, store, chunks, events } = await archive();
    const head = store.head;

    store.head = async key => {
      if (key.includes(chunks.o1.runId))
        throw Object.assign(new Error('InternalError from hunter2'), {
          name: 'InternalError',
          $metadata: { httpStatusCode: 500 },
        });

      return head(key);
    };

    const result = await run();

    expect(result.exitCode).toBe(2);

    const failed = result.checks.find(c => c.runId === chunks.o1.runId);

    expect(failed).toMatchObject({ ok: false, lines: 0, operational: 'InternalError from ***' });

    // The exporter's own record values ride along, source_count_after included, so --json describes
    // the chunk the same way everywhere.
    expect(failed?.counts).toEqual({
      run_id: chunks.o1.runId,
      collection: 'orders',
      mode: 'objectid-window',
      count_source: 'countDocuments',
      source_count: 5,
      exported_count: 5,
      matches: true,
    });

    expect(result.checks.filter(c => c.ok)).toHaveLength(3);
    expect(events.filter(e => e.type === 'chunk' && e.status === 'retry')).toHaveLength(2);
    expect(await store.getText(`${chunks.o1.key.replace('manifests', 'validation')}`)).toBeNull();
  });

  it('exits 130 or 143 when aborted, naming the interrupted chunks', async () => {
    const controller = new AbortController();
    const { run } = await archive({ signal: controller.signal });

    controller.abort('SIGTERM');

    const result = await run();

    expect(result.exitCode).toBe(143);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every(c => c.operational === 'interrupted')).toBe(true);

    const sigint = new AbortController();
    const second = await archive({ signal: sigint.signal });

    sigint.abort('SIGINT');
    expect((await second.run()).exitCode).toBe(130);
  });

  it('a signal during the listings returns the signal code and releases the lock', async () => {
    const controller = new AbortController();
    const { ctx, store, config, events } = await archive({ signal: controller.signal });

    controller.abort('SIGINT');

    const result = await verify({
      ctx,
      store: refusingStore(store, controller.signal),
      collections: [],
    });

    expect(result).toEqual({
      checks: [],
      skipped: 0,
      missing: [],
      invalidBatches: [],
      exitCode: 130,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warn',
        message: 'verify interrupted before any chunk was read',
      })
    );

    await (
      await acquireLock(config.stateDir, 'verify', false)
    )();
  });

  it('refuses to run beside another verify and releases its lock afterwards', async () => {
    const { run, config } = await archive();
    const release = await acquireLock(config.stateDir, 'verify', false);

    await expect(run()).rejects.toMatchObject({ msmCode: 'lock' });
    await release();
    await run();
    await expect(acquireLock(config.stateDir, 'verify', false)).resolves.toBeTypeOf('function');
  });

  it('ranks the exit codes: damage over unreadable chunks', async () => {
    const { run, store, seed, chunks } = await archive();

    await seed.chunk({
      collection: 'orders',
      batchId: B,
      mode: 'full-collection',
      lines: lines(4, 500),
      manifest: { exported_count: 3, source_count: 3 },
    });

    await seed.batch(B, 5);

    const head = store.head;

    store.head = async key => {
      if (key.includes(chunks.o1.runId))
        throw Object.assign(new Error('InternalError'), {
          name: 'InternalError',
          $metadata: { httpStatusCode: 500 },
        });

      return head(key);
    };

    expect((await run()).exitCode).toBe(3);
  });
});
