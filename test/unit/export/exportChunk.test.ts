import { readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Long, MongoServerError, ObjectId, type Document } from 'mongodb';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import createExportLedger from '../../../src/export/createExportLedger.js';
import exportChunk from '../../../src/export/exportChunk.js';
import idBrackets from '../../../src/mongo/idBrackets.js';
import tempDirOf from '../../../src/runtime/tempDirOf.js';
import type { ChunkPlan, ExportDeps } from '../../../src/types.js';
import { exampleConfig, memoryContext, tmpDir } from '../../helpers.js';
import { fakeCollection, fakeMongo, keysetPlan, type FakeCollectionSpec } from './fakeMongo.js';

const batchId = 'b1';

async function setup(spec: FakeCollectionSpec, over: Record<string, unknown> = {}, signal?: AbortSignal) {
  const stateDir = await tmpDir();
  const config = exampleConfig({ stateDir, minFreeDiskMb: 0, retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    export: { batchPrefix: 'app-archive', concurrency: 2, partMaxBytesMb: 1, partMaxDocs: 5_000_000, keysetPageDocs: 100, chunkAttempts: 3, ...over } });
  const mc = memoryContext({ config, signal, now: () => new Date('2026-10-13T02:10:11Z') });
  const fake = fakeCollection(spec);
  const deps: ExportDeps = { mongo: fakeMongo([fake]), store: mc.store, layout: mc.layout, ledger: createExportLedger(stateDir, batchId) };
  return { ...mc, deps, fake, stateDir };
}

const docs = (ids: unknown[]): Document[] => ids.map((_id) => ({ _id, n: Long.fromNumber(1) }));

const windowPlan = (layout: ReturnType<typeof memoryContext>['layout']): ChunkPlan => {
  const window = { start: new Date('2026-03-02T00:00:00Z'), end: new Date('2026-03-03T00:00:00Z') };
  const runId = `${batchId}-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z`;
  return {
    collection: 'audit_log', runId, mode: 'timestamp-window', tail: 'window',
    filter: { created_at: { $gte: window.start, $lt: window.end } },
    filterRecord: { mode: 'timestamp-window', field: 'created_at', start_utc: '2026-03-02T00:00:00+00:00', end_utc: '2026-03-03T00:00:00+00:00', boundary: '[start,end)', hint: 'created_at_1', query: {} },
    hint: 'created_at_1', paging: 'cursor', brackets: [], rawPrefix: layout.rawPrefix('audit_log', window, runId),
  };
};

describe('exportChunk', () => {
  it('writes parts, sidecars, both validation records, then the manifest, then the ledger line', async () => {
    const ids = [new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9'), new ObjectId('65f2a7e09d8c7b6a5f4e3d2c')];
    const { ctx, deps, store, layout, events } = await setup({ name: 'audit_log', docs: docs(ids) });
    const plan = windowPlan(layout);
    const order: string[] = [];
    const putText = store.putText.bind(store);
    store.putText = async (key, body, type) => { order.push(key); return putText(key, body, type); };
    const putFile = store.putFile.bind(store);
    store.putFile = async (key, path, opts) => { order.push(key); return putFile(key, path, opts); };

    const outcome = await exportChunk(ctx, deps, plan, 1);
    expect(outcome).toEqual({ chunk: plan.runId, collection: 'audit_log', status: 'done', docs: 2 });
    const partKey = layout.part(plan.rawPrefix, 1);
    expect(order).toEqual([partKey, `${partKey}.sha256`, layout.counts('audit_log', plan.runId), layout.parseCheck('audit_log', plan.runId), layout.chunkManifest('audit_log', plan.runId)]);

    const manifest = JSON.parse(store.objects.get(layout.chunkManifest('audit_log', plan.runId))!.toString('utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ run_id: plan.runId, source_count: 2, exported_count: 2, source_count_after: 2, counts_match: true,
      first_id: '65f1c0a1b2c3d4e5f6a7b8c9', last_id: '65f2a7e09d8c7b6a5f4e3d2c', file: { name: 'part-000001.jsonl.gz', s3_uri: layout.uri(partKey) },
      checksum_s3_uri: layout.uri(`${partKey}.sha256`), started_at: '2026-10-13T02:10:11+00:00' });
    expect(manifest.parts).toBeUndefined();
    const lines = gunzipSync(store.objects.get(partKey)!).toString('utf8').trimEnd().split('\n');
    expect(lines).toEqual(['{"_id":{"$oid":"65f1c0a1b2c3d4e5f6a7b8c9"},"n":{"$numberLong":"1"}}', '{"_id":{"$oid":"65f2a7e09d8c7b6a5f4e3d2c"},"n":{"$numberLong":"1"}}']);
    const parseCheck = JSON.parse(store.objects.get(layout.parseCheck('audit_log', plan.runId))!.toString('utf8')) as Record<string, unknown>;
    expect(parseCheck).toMatchObject({ gzip_test: true, first_line_parseable: true, first_line_has_id: true, manifest_only: false });
    const ledger = await deps.ledger.read();
    expect(ledger.get(plan.runId)?.exported_count).toBe(2);
    expect(events.map((e) => e.type === 'chunk' ? e.status : e.type)).toEqual(['start', 'part', 'done']);
  });

  it('splits into parts with one upload in flight and records parts[] with line counts', async () => {
    const { ctx, deps, store, layout } = await setup({ name: 'orders', docs: docs([1, 2, 3, 4, 5]), pages: [docs([1, 2, 3, 4, 5]), [], [], [], [], [], [], []] }, { partMaxDocs: 2 });
    const plan = keysetPlan(batchId, 'orders', idBrackets, layout.rawPrefix('orders', null, `${batchId}-orders-full-collection-full`));
    const outcome = await exportChunk(ctx, deps, plan, 1);
    expect(outcome.status).toBe('done');
    const manifest = JSON.parse(store.objects.get(layout.chunkManifest('orders', plan.runId))!.toString('utf8')) as { parts: { name: string; lines: number }[]; first_id: string; last_id: string };
    expect(manifest.parts.map((p) => [p.name, p.lines])).toEqual([['part-000001.jsonl.gz', 2], ['part-000002.jsonl.gz', 2], ['part-000003.jsonl.gz', 1]]);
    expect([manifest.first_id, manifest.last_id]).toEqual(['{"$numberInt":"1"}', '{"$numberInt":"5"}']);
    expect([...store.objects.keys()].filter((k) => k.endsWith('.sha256'))).toHaveLength(3);
    expect(await readdir(tempDirOf(ctx.config, 'export'))).toEqual([]);
  });

  it('throws count_mismatch while attempts remain and flags the chunk on the last one, rewriting the same keys', async () => {
    const make = () => setup({ name: 'audit_log', docs: docs([1, 2]), counts: [2, 3, 2, 3] });
    const { ctx, deps, store, layout } = await make();
    const plan = windowPlan(layout);
    await expect(exportChunk(ctx, deps, plan, 1)).rejects.toMatchObject({ msmCode: 'count_mismatch', message: 'before 2, after 3, exported 2' });
    expect(store.objects.has(layout.chunkManifest('audit_log', plan.runId))).toBe(false);
    expect(store.objects.has(layout.part(plan.rawPrefix, 1))).toBe(true);
    const last = await exportChunk(ctx, deps, plan, 3);
    expect(last).toMatchObject({ status: 'mismatch', docs: 2, code: 'count_mismatch', note: 'before 2, after 3, exported 2' });
    const manifest = JSON.parse(store.objects.get(layout.chunkManifest('audit_log', plan.runId))!.toString('utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ counts_match: false, source_count: 2, source_count_after: 3, exported_count: 2 });
    expect(store.objects.size).toBe(5);
  });

  it('writes a manifest-only chunk for an empty collection and flags one that filled up without writing anything', async () => {
    const plan = (layout: ReturnType<typeof memoryContext>['layout']): ChunkPlan => ({
      collection: 'coupons', runId: `${batchId}-coupons-manifest-only-full`, mode: 'manifest-only', tail: 'full', filter: {},
      filterRecord: { mode: 'manifest-only', filter: 'no raw export; manifest and validation only' }, hint: null, paging: 'none', brackets: [],
      rawPrefix: layout.rawPrefix('coupons', null, `${batchId}-coupons-manifest-only-full`),
    });
    const empty = await setup({ name: 'coupons', counts: [0] });
    expect(await exportChunk(empty.ctx, empty.deps, plan(empty.layout), 1)).toMatchObject({ status: 'done', docs: 0 });
    const manifest = JSON.parse(empty.store.objects.get(empty.layout.chunkManifest('coupons', `${batchId}-coupons-manifest-only-full`))!.toString('utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ mode: 'manifest-only', format: 'manifest_only', file: null, counts_match: true });
    expect([...empty.store.objects.keys()].some((k) => k.includes('/raw/'))).toBe(false);
    const filled = await setup({ name: 'coupons', counts: [4] });
    expect(await exportChunk(filled.ctx, filled.deps, plan(filled.layout), 1)).toMatchObject({ status: 'mismatch', docs: 0, note: 'before 0, after 4, exported 0' });
    // A flagged manifest-only record would outlive the resume that plans the collection with a strategy and block every load.
    expect(filled.store.objects.size).toBe(0);
    expect(filled.events.find((e) => e.type === 'chunk' && e.status === 'mismatch')).toMatchObject({ detail: 'collection has 4 documents now; rerun the batch to plan it with a strategy' });
  });

  it('a rest chunk counts and walks with its live-write gap anchored on the attempt, not on the batch start', async () => {
    const twoDaysAgo = new Date('2026-10-11T02:10:11Z');
    const { ctx, deps, fake, store, layout } = await setup({ name: 'audit_log', docs: docs([1]), pages: [docs([1]), [], [], [], [], [], [], []] });
    const runId = `${batchId}-audit_log-full-collection-rest`;
    const stale = { created_at: { $gte: new Date(twoDaysAgo.getTime() + 86_400_000) } };
    const plan: ChunkPlan = { ...keysetPlan(batchId, 'audit_log', idBrackets, layout.rawPrefix('audit_log', null, runId)), runId, tail: 'rest', hint: 'created_at_1',
      filter: { $or: [{ created_at: { $not: { $type: 'date' } } }, stale] }, filterRecord: { mode: 'full-collection', filter: 'documents outside the windows', hint: 'created_at_1', query: {} },
      liveGap: { key: 'created_at', kind: 'date', startedAt: twoDaysAgo } };
    expect((await exportChunk(ctx, deps, plan, 1)).status).toBe('done');
    const expected = { created_at: { $gte: new Date('2026-10-14T02:10:11Z') } };
    for (const c of fake.calls.filter((c) => c.method === 'countDocuments')) expect((c.args[0] as { $or: Document[] }).$or[1]).toEqual(expected);
    const page = fake.calls.find((c) => c.method === 'find');
    expect(JSON.stringify(page?.args[0])).toContain('2026-10-14T02:10:11.011Z'.slice(0, 19));
    const manifest = JSON.parse(store.objects.get(layout.chunkManifest('audit_log', runId))!.toString('utf8')) as { filter: { query: { $or: unknown[] } } };
    expect(manifest.filter.query.$or[1]).toEqual({ created_at: { $gte: { $date: { $numberLong: String(Date.UTC(2026, 9, 14, 2, 10, 11)) } } } });
  });

  it('skips a chunk another exporter committed meanwhile instead of overwriting its parts', async () => {
    const { ctx, deps, store, layout } = await setup({ name: 'audit_log', docs: docs([new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9')]) });
    const plan = windowPlan(layout);
    await exportChunk(ctx, deps, plan, 1);
    const before = new Map(store.objects);
    const other = await setup({ name: 'audit_log', docs: docs([new ObjectId('65f1c0a1b2c3d4e5f6a7b8ca')]) });
    for (const [k, v] of before) other.store.objects.set(k, v);
    const outcome = await exportChunk(other.ctx, { ...other.deps, store: other.store }, windowPlan(other.layout), 1);
    expect(outcome).toMatchObject({ status: 'skipped', note: 'committed by another exporter meanwhile' });
    expect([...other.store.objects.entries()].map(([k, v]) => [k, v.toString('base64')])).toEqual([...before.entries()].map(([k, v]) => [k, v.toString('base64')]));
    expect(other.fake.calls.filter((c) => c.method === 'countDocuments')).toHaveLength(0);
  });

  it('creates the chunk temp directory owner-only', async () => {
    const { ctx, deps, layout } = await setup({ name: 'audit_log', docs: docs([1]) });
    let seen: number | null = null;
    const putFile = deps.store.putFile.bind(deps.store);
    deps.store.putFile = async (key, path, opts) => { seen = (await stat(dirname(path))).mode & 0o777; return putFile(key, path, opts); };
    await exportChunk(ctx, deps, windowPlan(layout), 1);
    expect(seen).toBe(0o700);
  });

  it('stops between documents on abort, leaves no records and removes the temp directory', async () => {
    const controller = new AbortController();
    const many = docs(Array.from({ length: 50 }, (_, i) => i));
    const { ctx, deps, store, layout } = await setup({ name: 'audit_log', docs: many, onDoc: (i) => { if (i === 10) controller.abort('SIGINT'); } }, {}, controller.signal);
    const plan = windowPlan(layout);
    await expect(exportChunk(ctx, deps, plan, 1)).rejects.toMatchObject({ msmCode: 'interrupted' });
    expect(store.objects.size).toBe(0);
    // The area directory itself survives (readdir would throw if it did not), so a stale chunk directory fails loudly.
    expect(await readdir(tempDirOf(ctx.config, 'export'))).toEqual([]);
  });

  it('cleans up and rethrows when the cursor dies, so the chunk attempt restarts', async () => {
    const { ctx, deps, store, layout } = await setup({ name: 'audit_log', docs: docs([1, 2, 3]), failAfter: 2 });
    const plan = windowPlan(layout);
    await expect(exportChunk(ctx, deps, plan, 1)).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(store.objects.size).toBe(0);
    // The area directory itself survives (readdir would throw if it did not), so a stale chunk directory fails loudly.
    expect(await readdir(tempDirOf(ctx.config, 'export'))).toEqual([]);
  });

  it('reads nothing when the chunk counts zero, so an empty rest filter never scans the collection, and still catches a late write', async () => {
    const { ctx, deps, fake, store, layout } = await setup({ name: 'audit_log', docs: docs([1, 2, 3]), pages: [docs([1, 2, 3])], counts: [0, 0] });
    const runId = `${batchId}-audit_log-full-collection-rest`;
    const plan: ChunkPlan = { ...keysetPlan(batchId, 'audit_log', idBrackets, layout.rawPrefix('audit_log', null, runId)), runId, tail: 'rest', hint: 'created_at_1',
      filter: { $or: [{ created_at: { $not: { $type: 'date' } } }] }, filterRecord: { mode: 'full-collection', filter: 'documents outside the windows', hint: 'created_at_1', query: {} } };
    expect(await exportChunk(ctx, deps, plan, 1)).toMatchObject({ status: 'done', docs: 0 });
    expect(fake.calls.filter((c) => c.method === 'find')).toHaveLength(0);
    const manifest = JSON.parse(store.objects.get(layout.chunkManifest('audit_log', runId))!.toString('utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ source_count: 0, source_count_after: 0, exported_count: 0, counts_match: true, file: null });
    // A document that lands between the two counts shows up in the after count: the match rule is unchanged.
    const late = await setup({ name: 'audit_log', docs: docs([1]), counts: [0, 1, 0, 1, 0, 1] });
    await expect(exportChunk(late.ctx, late.deps, windowPlan(late.layout), 1)).rejects.toMatchObject({ msmCode: 'count_mismatch', message: 'before 0, after 1, exported 0' });
    expect(late.fake.calls.filter((c) => c.method === 'find')).toHaveLength(0);
  });

  it('the committed-meanwhile check swallows only an unreadable manifest; an S3 failure retries or stops the run', async () => {
    const { ctx, deps, store, layout } = await setup({ name: 'audit_log', docs: docs([1]) });
    const plan = windowPlan(layout);
    await store.putText(layout.chunkManifest('audit_log', plan.runId), '{ not json', 'application/json');
    expect((await exportChunk(ctx, deps, plan, 1)).status).toBe('done');
    const denied = await setup({ name: 'audit_log', docs: docs([1]) });
    denied.store.getText = async () => { throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }); };
    await expect(exportChunk(denied.ctx, denied.deps, windowPlan(denied.layout), 1)).rejects.toMatchObject({ name: 'AccessDenied' });
    expect(denied.fake.calls.filter((c) => c.method === 'countDocuments')).toHaveLength(0);
  });

  it('counts a rest chunk unhinted when the server refuses the field hint', async () => {
    const refusal = new MongoServerError({ message: 'hint provided does not correspond to an existing index', code: 2 });
    const { ctx, deps, fake, layout } = await setup({ name: 'audit_log', docs: docs([1]), pages: [docs([1]), [], [], [], [], [], [], []], countWithHintError: refusal });
    const runId = `${batchId}-audit_log-full-collection-rest`;
    const plan: ChunkPlan = { ...keysetPlan(batchId, 'audit_log', idBrackets, layout.rawPrefix('audit_log', null, runId)), runId, tail: 'rest', hint: 'created_at_1',
      filter: { $or: [{ created_at: { $not: { $type: 'date' } } }] }, filterRecord: { mode: 'full-collection', filter: 'documents outside the windows', hint: 'created_at_1', query: {} } };
    expect((await exportChunk(ctx, deps, plan, 1)).status).toBe('done');
    const counts = fake.calls.filter((c) => c.method === 'countDocuments').map((c) => (c.args[1] as Document).hint);
    expect(counts).toEqual(['created_at_1', undefined, undefined]);
  });
});
