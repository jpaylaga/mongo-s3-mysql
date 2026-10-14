import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import exitCodes from '../../../src/cli/exitCodes.js';
import selectCollections from '../../../src/config/selectCollections.js';
import infer from '../../../src/infer/infer.js';
import mappingSchema from '../../../src/mapping/mappingSchema.js';
import mappingToDdl from '../../../src/mapping/mappingToDdl.js';
import toolVersion from '../../../src/runtime/toolVersion.js';
import type { Config, InferOptions, MsmEvent } from '../../../src/types.js';
import { exampleConfig, memoryContext, refusingStore, tmpDir } from '../../helpers.js';
import seedChunks, { fixtureDocs } from './seedChunks.js';

const goldenPath = join(import.meta.dirname, '..', '..', '..', 'examples', 'orders.mapping.json');
const newest = 'app-archive-full-20261013T030000Z';
const older = 'app-archive-full-20261001T030000Z';

/** The golden mapping's flags: `infer -C orders --key-column mongo_id --run-id-column import_run --chunk-column _msm_chunk --extra-column _extra --child-tables`. */
const build: InferOptions['build'] = {
  keyColumn: 'mongo_id', runIdColumn: 'import_run', chunkColumn: '_msm_chunk', extraColumn: '_extra', timezone: 'UTC', childTables: true,
  minPresence: 0.02, maxColumns: 200,
};

/** Two batches of the orders fixture in a memory store; the newer one is the golden's sample. */
async function archive(options: { config?: Config; signal?: AbortSignal } = {}) {
  const config = options.config ?? exampleConfig({ infer: { minPresence: 0.02 } });
  const env = memoryContext({ command: 'infer', config, signal: options.signal, now: () => new Date('2026-10-13T03:10:00Z') });
  const seed = seedChunks(env.store, env.layout);
  const lines = (await fixtureDocs('orders')).map((d) => JSON.stringify(d));
  await seed.chunk({ collection: 'orders', batchId: newest, lines, partSize: 20 });
  await seed.batch(newest, '2026-10-13T03:00:00Z', 3);
  // The older batch holds only the first ten documents, so a sample from it is visibly different.
  await seed.chunk({ collection: 'orders', batchId: older, lines: lines.slice(0, 10) });
  await seed.batch(older, '2026-10-01T03:00:00Z');
  const outDir = join(await tmpDir(), 'mappings');
  const run = (patch: Partial<InferOptions> = {}) => infer({
    ctx: env.ctx, store: env.store, collections: selectCollections(config, ['orders']), outDir, build, ...patch,
  });
  return { ...env, outDir, run };
}

const messages = (events: MsmEvent[], type: 'info' | 'warn') =>
  events.filter((e) => e.type === type).map((e) => (e as { message: string }).message);

describe('infer', () => {
  it('writes the golden mapping and its DDL from the newest batch', async () => {
    const { run, outDir, events } = await archive();
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(result.files).toEqual([join(outDir, 'orders.mapping.json'), join(outDir, 'orders.sql')]);
    expect(result.review).toEqual([{ collection: 'orders', lines: [
      'note: present in 1.7% of samples -> left in _extra',
      '_id: 1 non-ObjectId _id in the sample; such lines are rejected (key cast objectId)',
    ] }]);

    const written = await readFile(join(outDir, 'orders.mapping.json'), 'utf8');
    // The golden carries the version it was generated with; a release bump must not fail this comparison.
    const golden = (await readFile(goldenPath, 'utf8')).replace(/"tool": "mongo-s3-mysql@\d+\.\d+\.\d+[^"]*"/, `"tool": "${toolVersion}"`);
    expect(written).toBe(golden);
    const mapping = mappingSchema.parse(JSON.parse(written));
    expect(await readFile(join(outDir, 'orders.sql'), 'utf8')).toBe(`${mappingToDdl(mapping).join('\n')}\n`);

    expect(messages(events, 'info')).toEqual([
      `orders: sampled 60 documents from 1 chunks of ${newest} (full batch)`,
      `orders: wrote ${join(outDir, 'orders.mapping.json')} and ${join(outDir, 'orders.sql')}`,
    ]);
    expect(messages(events, 'warn')).toEqual(result.review[0]?.lines.map((l) => `orders: ${l}`));
  });

  it('samples the batch named by --batch-id instead of the newest', async () => {
    const { run, outDir } = await archive();
    await run({ batchId: older });
    const mapping = JSON.parse(await readFile(join(outDir, 'orders.mapping.json'), 'utf8')) as { inferred: { sampled: number; review: string[] } };
    expect(mapping.inferred.sampled).toBe(10);
    expect(mapping.inferred.review).toEqual(['_id: 1 non-ObjectId _id in the sample; such lines are rejected (key cast objectId)']);
  });

  it('refuses existing output files before writing anything, unless forced', async () => {
    const { run, outDir, store, layout } = await archive();
    await seedChunks(store, layout).chunk({ collection: 'coupons', batchId: newest, lines: ['{"_id":{"$oid":"000000000000000000000001"},"code":"A"}'] });
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'orders.sql'), '-- hand edited\n', 'utf8');
    const collections = selectCollections(exampleConfig(), ['orders', 'coupons']);

    await expect(run({ collections })).rejects.toMatchObject({ msmCode: 'config', fatal: true, message: `infer: ${join(outDir, 'orders.sql')} already exist; pass --force to overwrite` });
    await expect(readFile(join(outDir, 'coupons.mapping.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(outDir, 'orders.sql'), 'utf8')).toBe('-- hand edited\n');

    const forced = await run({ collections, force: true });
    expect(forced.files).toHaveLength(4);
    expect(await readFile(join(outDir, 'orders.sql'), 'utf8')).toContain('CREATE TABLE IF NOT EXISTS `orders`');
  });

  it('warns, writes nothing and exits 2 for a collection no finished batch holds documents of', async () => {
    const { run, events } = await archive();
    const result = await run({ collections: selectCollections(exampleConfig(), ['coupons']) });
    expect(result).toEqual({ files: [], review: [], exitCode: 2 });
    expect(messages(events, 'warn')).toEqual(['coupons: no documents in any finished batch; no mapping written']);
    const named = await run({ collections: selectCollections(exampleConfig(), ['coupons']), batchId: older });
    expect(named.exitCode).toBe(2);
    expect(messages(events, 'warn').at(-1)).toBe(`coupons: no documents in batch ${older}; no mapping written`);
  });

  it('samples each collection from the newest finished batch that holds its documents, skipping running batches', async () => {
    const { run, outDir, store, layout } = await archive();
    const seed = seedChunks(store, layout);
    // coupons was exported only in the older batch; a newer, still running batch holds a manifest-only chunk of orders.
    await seed.chunk({ collection: 'coupons', batchId: older, lines: ['{"_id":{"$oid":"000000000000000000000001"},"code":"A"}'] });
    const running = 'app-archive-full-20261020T030000Z';
    await seed.chunk({ collection: 'orders', batchId: running, lines: [], mode: 'manifest-only' });
    await store.putText(layout.batchManifest(running), JSON.stringify({ run_id: running, ...layout.partition, cutoff_utc: '2026-10-20T03:00:00Z', completed_chunks: 0, failed_chunks: 1, completed_at: null, status: 'running' }), 'application/json');
    const result = await run({ collections: selectCollections(exampleConfig(), ['orders', 'coupons']) });
    expect(result.exitCode).toBe(0);
    expect(result.files).toHaveLength(4);
    const orders = JSON.parse(await readFile(join(outDir, 'orders.mapping.json'), 'utf8')) as { inferred: { sampled: number } };
    expect(orders.inferred.sampled).toBe(60);
    const coupons = JSON.parse(await readFile(join(outDir, 'coupons.mapping.json'), 'utf8')) as { inferred: { sampled: number }; columns: { column: string }[] };
    expect(coupons.inferred.sampled).toBe(1);
    expect(coupons.columns.map((c) => c.column)).toEqual(['code']);
  });

  it('prefers the newest full batch over a newer delta, which only holds the last windows, and says which kind it sampled', async () => {
    const { run, outDir, store, layout, events } = await archive();
    const seed = seedChunks(store, layout);
    const delta = 'app-archive-delta-20261020T030000Z';
    await seed.chunk({ collection: 'orders', batchId: delta, lines: ['{"_id":{"$oid":"000000000000000000000001"},"status":"paid"}'] });
    await store.putText(layout.batchManifest(delta), JSON.stringify({ run_id: delta, ...layout.partition, cutoff_utc: '2026-10-20T03:00:00Z', completed_chunks: 1, failed_chunks: 0, completed_at: '2026-10-20T03:11:00+00:00', backup_mode: 'delta-windowed-with-full-small-collections' }), 'application/json');
    // coupons exists only in the delta: it falls back to it.
    await seed.chunk({ collection: 'coupons', batchId: delta, lines: ['{"_id":{"$oid":"000000000000000000000002"},"code":"A"}'] });
    const result = await run({ collections: selectCollections(exampleConfig(), ['orders', 'coupons']) });
    expect(result.exitCode).toBe(0);
    const orders = JSON.parse(await readFile(join(outDir, 'orders.mapping.json'), 'utf8')) as { inferred: { sampled: number } };
    expect(orders.inferred.sampled).toBe(60);
    expect(messages(events, 'info')).toContain(`orders: sampled 60 documents from 1 chunks of ${newest} (full batch)`);
    expect(messages(events, 'info')).toContain(`coupons: sampled 1 documents from 1 chunks of ${delta} (delta batch)`);
    // A tool batch records its kind in the frozen plan.
    const toolDelta = 'nightly-2026-10-21';
    await seed.chunk({ collection: 'orders', batchId: toolDelta, lines: ['{"_id":{"$oid":"000000000000000000000003"}}'] });
    await store.putText(layout.batchManifest(toolDelta), JSON.stringify({ run_id: toolDelta, ...layout.partition, cutoff_utc: '2026-10-21T03:00:00Z', completed_chunks: 1, failed_chunks: 0, completed_at: '2026-10-21T03:11:00+00:00', status: 'complete', started_at: '2026-10-21T03:00:00+00:00', plan: { kind: 'delta', include_rest: false, collections: [] } }), 'application/json');
    const again = await run({ force: true });
    expect(again.exitCode).toBe(0);
    expect(messages(events, 'info').filter((m) => m.startsWith('orders: sampled')).at(-1)).toBe(`orders: sampled 60 documents from 1 chunks of ${newest} (full batch)`);
  });

  it('a collection whose part is missing, misaddressed or whose manifest is damaged is reported and the others still get their files', async () => {
    const { run, outDir, store, layout, events } = await archive();
    const seed = seedChunks(store, layout);
    const { partKeys } = await seed.chunk({ collection: 'gone', batchId: newest, lines: ['{"_id":{"$oid":"000000000000000000000001"}}'] });
    store.objects.delete(partKeys[0] as string);
    const { runId } = await seed.chunk({ collection: 'broken', batchId: newest, lines: ['{"_id":{"$oid":"000000000000000000000001"},"a":1}'] });
    await store.putText(layout.chunkManifest('broken', runId), '{ not json', 'application/json');
    const result = await run({ collections: selectCollections(exampleConfig(), ['gone', 'broken', 'orders']) });
    expect(result.exitCode).toBe(exitCodes.incomplete);
    expect(result.files).toEqual([join(outDir, 'orders.mapping.json'), join(outDir, 'orders.sql')]);
    expect(messages(events, 'warn')).toContainEqual(expect.stringMatching(/^gone: .*part is missing; run verify; no mapping written$/));
    expect(messages(events, 'warn')).toContainEqual(expect.stringMatching(/^broken: chunk manifest .* does not parse and is left out of the sample \(.*\); run verify$/));
    expect(messages(events, 'warn')).toContain('broken: no documents in any finished batch; no mapping written');
  });

  it('a document nested thousands of levels deep (a foreign or tampered line) maps as json instead of ending the run', async () => {
    const { run, outDir, store, layout } = await archive();
    const line = `{"_id":{"$oid":"000000000000000000000001"},"a":${'[{"a":'.repeat(5000)}1${'}]'.repeat(5000)}}`;
    await seedChunks(store, layout).chunk({ collection: 'deep', batchId: newest, lines: [line] });
    const result = await run({ collections: selectCollections(exampleConfig(), ['deep', 'orders']) });
    expect(result.exitCode).toBe(exitCodes.ok);
    expect(result.files).toHaveLength(4);
    const deep = mappingSchema.parse(JSON.parse(await readFile(join(outDir, 'deep.mapping.json'), 'utf8')));
    // With --child-tables the outer array is a child table whose nested array (past the depth bound) is kept as json.
    expect(deep.columns).toEqual([]);
    expect(deep.children[0]?.columns.map((c) => [c.column, c.cast])).toEqual([['a', 'json']]);
  });

  it('maps an array of subdocuments that carry their own _id as a child table instead of failing the run', async () => {
    const { run, outDir, store, layout } = await archive();
    const items = '[{"_id":{"$oid":"000000000000000000000011"},"sku":"A"},{"_id":{"$oid":"000000000000000000000012"},"sku":"B"}]';
    await seedChunks(store, layout).chunk({ collection: 'carts', batchId: newest, lines: [`{"_id":{"$oid":"000000000000000000000001"},"items":${items}}`, `{"_id":{"$oid":"000000000000000000000002"},"items":${items}}`] });
    const result = await run({ collections: selectCollections(exampleConfig(), ['carts', 'orders']) });
    expect(result.exitCode).toBe(0);
    const carts = mappingSchema.parse(JSON.parse(await readFile(join(outDir, 'carts.mapping.json'), 'utf8')));
    expect(carts.children[0]?.columns.map((c) => [c.column, c.source, c.cast])).toEqual([['id_2', '_id', 'objectId'], ['sku', 'sku', 'string']]);
  });

  it('fails without a batch manifest and without --batch-id', async () => {
    const env = memoryContext({ command: 'infer' });
    const outDir = await tmpDir();
    await expect(infer({ ctx: env.ctx, store: env.store, collections: selectCollections(env.config, ['orders']), outDir, build }))
      .rejects.toMatchObject({ msmCode: 'config', message: 'infer: no batch manifest under the prefix; pass --batch-id' });
  });

  it('discovers the collections from the manifests prefix when the config lists none', async () => {
    const { run, outDir } = await archive();
    const result = await run({ collections: [] });
    expect(result.files).toEqual([join(outDir, 'orders.mapping.json'), join(outDir, 'orders.sql')]);
  });

  it('applies --table verbatim and the config infer settings', async () => {
    const { run, outDir } = await archive({ config: exampleConfig() });
    await run({ build: { ...build, table: 'ArchivedOrders', childTables: false, minPresence: 0.01 } });
    const mapping = mappingSchema.parse(JSON.parse(await readFile(join(outDir, 'orders.mapping.json'), 'utf8')));
    expect(mapping.table).toBe('ArchivedOrders');
    expect(mapping.children).toEqual([]);
    // 1 of 60 is above the default 1% presence, so `note` earns a column instead of a review line.
    expect(mapping.columns.map((c) => c.column)).toEqual(['status', 'total', 'sequence', 'paid', 'created_at', 'customer', 'tags', 'items', 'note']);
    expect(await readFile(join(outDir, 'orders.sql'), 'utf8')).toContain('CREATE TABLE IF NOT EXISTS `ArchivedOrders`');
  });

  it('an abort returns the signal exit code with the files written so far instead of rejecting', async () => {
    const controller = new AbortController();
    const { run } = await archive({ signal: controller.signal });
    controller.abort('SIGINT');
    const result = await run();
    expect(result).toMatchObject({ files: [], exitCode: exitCodes.sigint });
  });

  it('a signal during the opening listings (a store that refuses calls once aborted, like S3) is a result too, not a rejection', async () => {
    for (const [signal, code] of [['SIGINT', exitCodes.sigint], ['SIGTERM', exitCodes.sigterm]] as const) {
      const controller = new AbortController();
      const { ctx, store, outDir, events } = await archive({ signal: controller.signal });
      controller.abort(signal);
      const result = await infer({ ctx, store: refusingStore(store, controller.signal), collections: [], outDir, build });
      expect(result).toEqual({ files: [], review: [], exitCode: code });
      expect(messages(events, 'warn')).toContain('infer interrupted after 0 of 0 collections');
    }
  });

  it('warns when the config points load at another mapping path, instead of writing over that file', async () => {
    const { run, outDir, events } = await archive();
    const configured = selectCollections(exampleConfig(), ['orders']).map((c) => ({ ...c, mapping: '/srv/curated/orders.mapping.json' }));
    const result = await run({ collections: configured });
    expect(result.files).toEqual([join(outDir, 'orders.mapping.json'), join(outDir, 'orders.sql')]);
    expect(messages(events, 'warn')).toContain('orders: the config reads collections[].mapping /srv/curated/orders.mapping.json; copy the new file there or point mapping at it before load');
  });
});
