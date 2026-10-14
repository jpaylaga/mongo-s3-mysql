import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MongoClient, type Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import exportArchive from '../../src/export/exportArchive.js';
import infer from '../../src/infer/infer.js';
import inventory from '../../src/inventory/inventory.js';
import chunkRunId from '../../src/layout/chunkRunId.js';
import createLayout from '../../src/layout/createLayout.js';
import listChunkManifests from '../../src/layout/listChunkManifests.js';
import readRecord from '../../src/layout/readRecord.js';
import recordSchemas from '../../src/layout/recordSchemas.js';
import load from '../../src/load/load.js';
import loadMapping from '../../src/mapping/loadMapping.js';
import reconcile from '../../src/reconcile/reconcile.js';
import createContext from '../../src/runtime/createContext.js';
import createS3Store from '../../src/s3/createS3Store.js';
import type { Config, LedgerRow, MongoHandle, MysqlHandle, ObjectStore } from '../../src/types.js';
import verify from '../../src/verify/verify.js';
import { comparable, expectedAuditRows, expectedOrderRows, type Row } from './expectedRows.js';
import runCli from './runCli.js';
import seedTwin, { auditCreatedAt, auditDocument, auditPerDay, fieldlessAudit, objectIdAt } from './seedTwin.js';
import startStack, { configJson, database, mongoPassword, mysqlPassword, runTool, type Stack } from './startStack.js';
import twinDdl from './twinDdl.js';

const examplesDir = new URL('../../examples/', import.meta.url);
const auditMappingPath = fileURLToPath(new URL('audit_log.mapping.json', examplesDir));

// Fixed clocks: the full batch sees three seeded days before its cutoff, the delta one day more.
const fullNow = new Date('2026-03-05T01:10:00Z');
const deltaNow = new Date('2026-03-06T01:10:00Z');
const F = 'app-archive-full-20260305T011000Z';
const D = 'app-archive-delta-20260306T011000Z';
const win = (day: string) => ({ start: new Date(`${day}T00:00:00Z`), end: new Date(`${new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`) });

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex');
const sql = async (mysql: MysqlHandle, text: string, params: unknown[] = []): Promise<Row[]> => (await mysql.pool.query(text, params))[0] as Row[];
const readAll = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const auditColumns = ['source_mongo_id', 'actor_id', 'description', 'data', 'ip_address', 'location', 'created_at', 'updated_at', 'backfill_run_id'];
const orderColumns = ['mongo_id', 'status', 'total', 'sequence', 'paid', 'created_at', 'customer', 'tags', 'import_run', '_extra'];
const itemColumns = ['order_mongo_id', 'item_index', 'sku', 'qty', 'price'];

describe('round trip: inventory, export, verify, infer, load, reconcile on the twin stack', () => {
  let stack: Stack;
  let config: Config;
  let probe: ObjectStore;
  let layout: ReturnType<typeof createLayout>;
  const docs: { audit: Document[]; orders: Document[] } = { audit: [], orders: [] };

  /** The audit_log entry points at the example mapping; orders uses the inferred one; coupons has none. */
  const collections = (stack: Stack) => (configJson(stack).collections as Record<string, unknown>[])
    .map((c) => (c.name === 'audit_log' ? { ...c, mapping: auditMappingPath } : c));

  const sourceDocs = async (name: string): Promise<Document[]> => {
    const client = new MongoClient(stack.mongoUri, { promoteValues: false, promoteLongs: false, promoteBuffers: false });
    try {
      return await client.db(database).collection(name).find({}).sort({ _id: 1 }).toArray();
    } finally {
      await client.close();
    }
  };
  const ledger = (mysql: MysqlHandle, table?: string): Promise<LedgerRow[]> =>
    sql(mysql, `SELECT * FROM \`_msm_load_chunks\`${table ? ' WHERE `target_table` = ?' : ''} ORDER BY \`id\``, table ? [table] : []) as unknown as Promise<LedgerRow[]>;
  const withMysql = <T>(fn: (mysql: MysqlHandle) => Promise<T>) => runTool(stack, 'reconcile', { mysql: true }, {}, async ({ clients }) => ({ value: await fn(clients.mysql as MysqlHandle) }));

  const runExport = (options: { now: Date; batchId?: string; since?: string; dryRun?: boolean; wrap?: Parameters<typeof runTool>[3]['wrap'] }) =>
    runTool(stack, 'export', { mongo: true, s3: true }, { now: options.now, config, wrap: options.wrap }, ({ ctx, clients }) =>
      exportArchive({ ctx, mongo: clients.mongo as MongoHandle, store: clients.store as ObjectStore, collections: config.collections, batchId: options.batchId, since: options.since, dryRun: options.dryRun }));
  const runVerify = (options: { all?: boolean } = {}) =>
    runTool(stack, 'verify', { s3: true }, { config }, ({ ctx, clients }) => verify({ ctx, store: clients.store as ObjectStore, collections: config.collections, all: options.all }));
  const runLoad = (options: { now?: Date; cfg?: Config; names?: string[]; batchIds?: string[]; reload?: boolean; createTables?: boolean; wrap?: Parameters<typeof runTool>[3]['wrap'] } = {}) => {
    const cfg = options.cfg ?? config;
    const selected = options.names === undefined ? cfg.collections : cfg.collections.filter((c) => options.names?.includes(c.name));
    return runTool(stack, 'load', { s3: true, mysql: true }, { now: options.now ?? fullNow, config: cfg, wrap: options.wrap }, ({ ctx, clients }) =>
      load({ ctx, store: clients.store as ObjectStore, mysql: clients.mysql as MysqlHandle, collections: selected, batchIds: options.batchIds, reload: options.reload, createTables: options.createTables }));
  };
  const runReconcile = (options: { deep?: boolean; ignore?: ('table_count' | 'missing_rows')[]; names?: string[] } = {}) =>
    runTool(stack, 'reconcile', { s3: true, mysql: true }, { config }, ({ ctx, clients }) =>
      reconcile({ ctx, store: clients.store as ObjectStore, mysql: clients.mysql as MysqlHandle, collections: options.names ? config.collections.filter((c) => options.names?.includes(c.name)) : config.collections, deep: options.deep, ignore: options.ignore, confirm: async () => {} }));

  beforeAll(async () => {
    stack = await startStack();
    await writeFile(stack.configPath, `${JSON.stringify(configJson(stack, { collections: collections(stack) }), null, 2)}\n`);
    config = stack.config({ collections: collections(stack) });
    layout = createLayout(config.s3);
    probe = createS3Store(config.s3, createContext({ config, command: 'verify' }));
    await seedTwin(stack.mongoUri);
    docs.audit = await sourceDocs('audit_log');
    docs.orders = await sourceDocs('orders');
  }, 600_000);

  afterAll(async () => { await stack?.stop(); });

  it('1. inventory suggests full-collection for all three small collections and sees coupons empty', async () => {
    const report = await runTool(stack, 'inventory', { mongo: true }, { config }, ({ ctx, clients }) => inventory({ ctx, mongo: clients.mongo as MongoHandle, all: true }));
    expect(report.exitCode).toBe(0);
    expect(report.skipped).toEqual([]);
    const byName = new Map(report.collections.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual(['audit_log', 'coupons', 'orders']);
    for (const c of byName.values()) expect(c.suggestion.strategy).toBe('full-collection');
    expect(byName.get('coupons')?.estimatedCount).toBe(0);
    expect(byName.get('audit_log')?.indexedFields).toContain('created_at');
  });

  it('2. export is interrupted by SIGINT at part 2 of the second audit_log window, then resumes to a complete batch', async () => {
    const second = chunkRunId(F, 'audit_log', 'timestamp-window', win('2026-03-03'));
    const interrupted = await runExport({
      now: fullNow,
      wrap: (clients, controller) => ({
        ...clients,
        store: {
          ...(clients.store as ObjectStore),
          putFile: (key, path, opts) => {
            if (key.includes(`run_id=${second}/`) && key.endsWith('part-000002.jsonl.gz')) controller.abort('SIGINT');
            return (clients.store as ObjectStore).putFile(key, path, opts);
          },
        },
      }),
    });
    expect(interrupted.batchId).toBe(F);
    expect(interrupted.exitCode).toBe(130);
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.outcomes.some((o) => o.chunk === second && o.status === 'interrupted')).toBe(true);
    expect(await probe.getText(layout.chunkManifest('audit_log', second))).toBeNull();
    const batch = await readRecord(probe, layout.batchManifest(F), recordSchemas.batchManifest);
    expect(batch?.value.status).toBe('interrupted');
    expect(batch?.value.failed_chunks).toBeGreaterThan(0);

    const resumed = await runExport({ now: fullNow, batchId: F });
    expect(resumed.exitCode, resumed.events.filter((e) => e.type !== 'progress').map((e) => JSON.stringify(e)).join('\n')).toBe(0);
    expect(resumed.status).toBe('complete');
    expect(resumed.outcomes.every((o) => o.status === 'done')).toBe(true);

    // 6.1: every key under the prefix matches one of the templates, with the example partition in path order.
    const P = 'account_id=111122223333/region=us-east-1/cluster=example-cluster/database=app';
    const { keys } = await probe.list('mongo-archive/');
    const templates = [
      new RegExp(`^mongo-archive/raw/${P}/collection=[a-z_]+/source_year=(\\d{4}|all)/source_month=(\\d{2}|all)/source_day=(\\d{2}|all)/source_hour=(\\d{2}|all)/run_id=${F}-[A-Za-z0-9_-]+/part-\\d{6}\\.jsonl\\.gz(\\.sha256)?$`),
      new RegExp(`^mongo-archive/manifests/${P}/collection=[a-z_]+/run_id=${F}-.+\\.json$`),
      new RegExp(`^mongo-archive/manifests/${P}/run_id=${F}\\.json$`),
      new RegExp(`^mongo-archive/validation/${P}/collection=[a-z_]+/run_id=${F}-.+/(counts|parse-check)\\.json$`),
    ];
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expect(templates.some((t) => t.test(key)), key).toBe(true);
    expect(keys.filter((k) => k.endsWith('.jsonl.gz')).length).toBe(keys.filter((k) => k.endsWith('.sha256')).length);

    const audit = await listChunkManifests(probe, layout, 'audit_log', F);
    const orders = await listChunkManifests(probe, layout, 'orders', F);
    const coupons = await listChunkManifests(probe, layout, 'coupons', F);
    expect(audit.map((m) => m.id.tail).sort()).toEqual(['rest', 'window', 'window', 'window']);
    expect(audit.filter((m) => m.id.tail === 'window').reduce((s, m) => s + m.manifest.exported_count, 0)).toBe(3 * auditPerDay - 1);
    expect(audit.filter((m) => m.id.tail === 'window').every((m) => m.parts.length === 3)).toBe(true);
    const auditRest = audit.find((m) => m.id.tail === 'rest');
    const fieldless = objectIdAt(auditCreatedAt('2026-03-03', fieldlessAudit.k).getTime(), fieldlessAudit.day * auditPerDay + fieldlessAudit.k + 1).toHexString();
    expect(auditRest?.manifest).toMatchObject({ exported_count: 1, counts_match: true, first_id: fieldless, last_id: fieldless, mode: 'full-collection' });
    expect(auditRest?.manifest.filter).toMatchObject({ filter: 'documents outside the windows' });
    // The ObjectId grid runs from the observed minimum (March 1) to the cutoff, so the fourth day window is empty.
    expect(orders.map((m) => m.id.tail).sort()).toEqual(['rest', 'window', 'window', 'window', 'window']);
    expect(orders.find((m) => m.id.window?.start.toISOString().startsWith('2026-03-04'))?.manifest).toMatchObject({ exported_count: 0, file: null, counts_match: true });
    expect(orders.find((m) => m.id.tail === 'rest')?.manifest).toMatchObject({ exported_count: 1, first_id: 'legacy-7' });
    expect(orders.filter((m) => m.id.tail === 'window').reduce((s, m) => s + m.manifest.exported_count, 0)).toBe(59);
    expect(coupons).toHaveLength(1);
    expect(coupons[0]?.manifest).toMatchObject({ mode: 'manifest-only', format: 'manifest_only', file: null, checksum_s3_uri: null, exported_count: 0, counts_match: true });
    expect(coupons[0]?.parts).toEqual([]);

    for (const m of [...audit, ...orders]) {
      for (const part of m.parts) {
        const body = await readAll((await probe.getStream(part.key as string)) as NodeJS.ReadableStream);
        expect(body.length).toBe(part.bytes);
        expect(sha256(body)).toBe(part.sha256);
        expect(await probe.getText(`${part.key}.sha256`)).toBe(`${part.sha256}  ${part.name}\n`);
      }
    }
  });

  it('3. verify passes and a second run skips every chunk', async () => {
    const first = await runVerify();
    expect(first.exitCode).toBe(0);
    expect(first.missing).toEqual([]);
    expect(first.checks.length).toBe(10);
    expect(first.checks.every((c) => c.ok)).toBe(true);
    const second = await runVerify();
    expect(second.exitCode).toBe(0);
    expect(second.checks).toEqual([]);
    expect(second.skipped).toBe(10);
  });

  it('4. infer reproduces the golden orders mapping and sensible casts for audit_log', async () => {
    const build = { keyColumn: 'mongo_id', runIdColumn: 'import_run', chunkColumn: '_msm_chunk', extraColumn: '_extra', timezone: 'UTC', childTables: true, minPresence: config.infer.minPresence, maxColumns: config.infer.maxColumns };
    const ordersCc = config.collections.filter((c) => c.name === 'orders');
    const result = await runTool(stack, 'infer', { s3: true }, { config, now: fullNow }, ({ ctx, clients }) => infer({ ctx, store: clients.store as ObjectStore, collections: ordersCc, outDir: config.mappingsDir, build }));
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(await readFile(join(config.mappingsDir, 'orders.mapping.json'), 'utf8')) as { inferred: Record<string, unknown> };
    const golden = JSON.parse(await readFile(new URL('orders.mapping.json', examplesDir), 'utf8')) as { inferred: Record<string, unknown> };
    // `at` is the clock and `tool` the version the golden was generated with; neither may fail a release.
    delete written.inferred.at;
    delete golden.inferred.at;
    delete written.inferred.tool;
    delete golden.inferred.tool;
    expect(written).toEqual(golden);

    const auditOut = join(stack.workDir, 'inferred');
    const auditCc = config.collections.filter((c) => c.name === 'audit_log');
    const plain = { ...build, runIdColumn: null, chunkColumn: null, extraColumn: null, childTables: false };
    await runTool(stack, 'infer', { s3: true }, { config, now: fullNow }, ({ ctx, clients }) => infer({ ctx, store: clients.store as ObjectStore, collections: auditCc, outDir: auditOut, build: plain }));
    const audit = JSON.parse(await readFile(join(auditOut, 'audit_log.mapping.json'), 'utf8')) as { key: { cast: string }; columns: { column: string; cast: string }[] };
    expect(audit.key.cast).toBe('objectId');
    const casts = Object.fromEntries(audit.columns.map((c) => [c.column, c.cast]));
    expect(casts).toMatchObject({ actor_id: 'string', description: 'string', data: 'json', ip_address: 'string', location: 'json', created_at: 'datetime', updated_at: 'datetime' });
  });

  it('5. load fills the hand-made twin table and the created orders tables; legacy-7 is rejected', async () => {
    await withMysql(async (mysql) => { await mysql.pool.query(twinDdl); });
    const result = await runLoad({ createTables: true });
    expect(result.exitCode).toBe(0);
    expect(result.loadRunId).toBe('load-20260305T011000Z');
    expect(result.events.some((e) => e.type === 'warn' && /coupons: no mapping/.test(e.message))).toBe(true);
    expect(result.outcomes.filter((o) => o.status === 'done')).toHaveLength(9);
    expect(result.perTable.find((t) => t.table === 'audit_log_entries')).toMatchObject({ chunks: 4, inserted: 300, updated: 0, rejected: 0 });
    expect(result.perTable.find((t) => t.table === 'orders')).toMatchObject({ chunks: 5, inserted: 59, updated: 0, rejected: 1 });
    const { value: rejects } = await withMysql((mysql) => sql(mysql, 'SELECT `reason`, `line_text` FROM `_msm_load_rejects`'));
    expect(rejects).toHaveLength(1);
    expect(String(rejects[0]?.line_text)).toContain('legacy-7');
  });

  it('6. every loaded row equals what the driver reads from the source', async () => {
    // Documents without actor_id and with a null description are in the seed, so the `""` defaults are exercised against the NOT NULL columns.
    expect(docs.audit.filter((d) => d.actor_id === undefined).length).toBeGreaterThan(0);
    expect(docs.audit.filter((d) => d.description === null).length).toBeGreaterThan(0);
    const { value: actual } = await withMysql(async (mysql) => ({
      audit: await sql(mysql, 'SELECT * FROM `audit_log_entries` ORDER BY `id`'),
      orders: await sql(mysql, 'SELECT * FROM `orders` ORDER BY `id`'),
      items: await sql(mysql, 'SELECT * FROM `orders_items` ORDER BY `id`'),
      ledgerIds: (await sql(mysql, "SELECT `id` FROM `_msm_load_chunks` WHERE `target_table` = 'orders'")).map((r) => Number(r.id)),
    }));
    const expectedAudit = expectedAuditRows(docs.audit, 'load-20260305T011000Z');
    expect(actual.audit).toHaveLength(expectedAudit.size);
    for (const row of actual.audit) expect(comparable(row, ['data', 'location'], auditColumns)).toEqual(expectedAudit.get(String(row.source_mongo_id)));
    const expectedOrders = expectedOrderRows(docs.orders, 'load-20260305T011000Z');
    expect(actual.orders).toHaveLength(expectedOrders.rows.size);
    for (const row of actual.orders) {
      expect(comparable(row, ['customer', 'tags', '_extra'], orderColumns)).toEqual(expectedOrders.rows.get(String(row.mongo_id)));
      expect(actual.ledgerIds).toContain(Number(row._msm_chunk));
    }
    expect(actual.items).toHaveLength(expectedOrders.items.size);
    for (const row of actual.items) expect(comparable(row, [], itemColumns)).toEqual(expectedOrders.items.get(`${String(row.order_mongo_id)}:${Number(row.item_index)}`));
  });

  it('7. reconcile finds no drift; the key ledger covers both tables', async () => {
    const result = await runReconcile();
    expect(result.drifts).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.perTable.find((t) => t.table === 'audit_log_entries')).toMatchObject({ chunks: 4, keyed: 300, untracked: 0, foreign: 0, rejected: 0 });
    expect(result.perTable.find((t) => t.table === 'orders')).toMatchObject({ chunks: 5, keyed: 59, untracked: 0, foreign: 0, rejected: 1 });
  });

  it('8. load is idempotent: skips, reload with the same run id, reload under a mapping without provenance columns', async () => {
    const again = await runLoad();
    expect(again.exitCode).toBe(0);
    expect(again.outcomes.every((o) => o.status === 'skipped' && o.note === 'already loaded')).toBe(true);

    const snapshot = async () => withMysql(async (mysql) => ({
      audit: await sql(mysql, 'SELECT * FROM `audit_log_entries` ORDER BY `id`'),
      orders: await sql(mysql, 'SELECT * FROM `orders` ORDER BY `id`'),
      items: await sql(mysql, 'SELECT `order_mongo_id`, `item_index`, `sku`, `qty`, `price` FROM `orders_items` ORDER BY `order_mongo_id`, `item_index`'),
    }));
    const before = (await snapshot()).value;
    const reload = await runLoad({ reload: true });
    expect(reload.exitCode).toBe(0);
    expect(reload.outcomes.filter((o) => o.status === 'done')).toHaveLength(9);
    expect(reload.perTable.find((t) => t.table === 'audit_log_entries')).toMatchObject({ inserted: 0, updated: 300 });
    expect(reload.events.some((e) => e.type === 'retry')).toBe(false);
    expect((await snapshot()).value).toEqual(before);
    expect((await runReconcile()).exitCode).toBe(0);

    const original = await loadMapping(join(config.mappingsDir, 'orders.mapping.json'));
    const stripped = { ...original.mapping, runIdColumn: null, chunkColumn: null };
    delete (stripped as { inferred?: unknown }).inferred;
    const strippedPath = join(stack.workDir, 'orders-no-provenance.mapping.json');
    await writeFile(strippedPath, JSON.stringify(stripped, null, 2));
    const cfg = stack.config({ collections: collections(stack).map((c) => (c.name === 'orders' ? { ...c, mapping: strippedPath } : c)) });
    const noProvenance = await runLoad({ cfg, names: ['orders'], reload: true });
    expect(noProvenance.exitCode).toBe(0);
    expect(noProvenance.events.some((e) => e.type === 'retry' || (e.type === 'chunk' && /insert_race/.test(e.detail ?? '')))).toBe(false);
    expect((await snapshot()).value).toEqual(before);
    const { value: strippedLedger } = await withMysql((mysql) => ledger(mysql, 'orders'));
    expect(strippedLedger.every((r) => r.mapping_sha256 !== original.sha256)).toBe(true);

    const restored = await runLoad({ names: ['orders'], reload: true });
    expect(restored.exitCode).toBe(0);
    const { value: restoredLedger } = await withMysql((mysql) => ledger(mysql, 'orders'));
    expect(restoredLedger.every((r) => r.mapping_sha256 === original.sha256 && r.status === 'loaded')).toBe(true);
    expect((await snapshot()).value).toEqual(before);
  });

  it('9. a delta batch carries an update inside the overlap and two inserts through verify, load and reconcile', async () => {
    const edited = objectIdAt(auditCreatedAt('2026-03-04', 99).getTime(), 2 * auditPerDay + 99 + 1);
    const client = new MongoClient(stack.mongoUri);
    try {
      const coll = client.db(database).collection('audit_log');
      const updated = await coll.updateOne({ _id: edited }, { $set: { description: 'edited after the full export' } });
      expect(updated.matchedCount).toBe(1);
      await coll.insertMany([auditDocument('2026-03-05', 10, 300), auditDocument('2026-03-05', 20, 301)]);
    } finally {
      await client.close();
    }
    const delta = await runExport({ now: deltaNow, since: 'last' });
    expect(delta.batchId).toBe(D);
    expect(delta.exitCode).toBe(0);
    expect(delta.status).toBe('complete');
    expect(delta.events.some((e) => e.type === 'warn' && /rest chunk skipped \(delta batch\)/.test(e.message))).toBe(true);
    const batch = await readRecord(probe, layout.batchManifest(D), recordSchemas.batchManifest);
    expect(batch?.value).toMatchObject({ backup_mode: 'delta-windowed-with-full-small-collections', requested_start_utc: '2026-03-04T23:00:00Z', status: 'complete' });
    const auditDelta = await listChunkManifests(probe, layout, 'audit_log', D);
    // The overlap window [23:00, 00:00) of the last seeded day holds its last four documents; the new day holds the two inserts.
    expect(auditDelta.map((m) => m.manifest.exported_count).sort()).toEqual([2, 4]);

    expect((await runVerify()).exitCode).toBe(0);
    const loaded = await runLoad({ now: deltaNow });
    expect(loaded.exitCode).toBe(0);
    expect(loaded.loadRunId).toBe('load-20260306T011000Z');
    expect(loaded.outcomes.filter((o) => o.status === 'done').map((o) => o.chunk).every((c) => c.startsWith(D))).toBe(true);
    expect((await runReconcile()).exitCode).toBe(0);

    const { value: rows } = await withMysql((mysql) => sql(mysql, 'SELECT `source_mongo_id`, `description`, `backfill_run_id` FROM `audit_log_entries` WHERE `backfill_run_id` = ?', ['load-20260306T011000Z']));
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.source_mongo_id === edited.toHexString())?.description).toBe('edited after the full export');
    const { value: count } = await withMysql((mysql) => sql(mysql, 'SELECT COUNT(*) AS c FROM `audit_log_entries`'));
    expect(Number(count[0]?.c)).toBe(302);
  });

  it('10. an interrupted load resumes from lines_done, a multiple of the batch size', async () => {
    let commits = 0;
    const interrupted = await runLoad({
      reload: true, batchIds: [F, D],
      wrap: (clients, controller) => {
        const mysql = clients.mysql as MysqlHandle;
        const pool = new Proxy(mysql.pool, {
          get(target, prop, receiver) {
            if (prop !== 'getConnection') return Reflect.get(target, prop, receiver) as unknown;
            return async () => {
              const conn = await target.getConnection();
              return new Proxy(conn, {
                get(c, p, r) {
                  if (p !== 'query') return Reflect.get(c, p, r) as unknown;
                  return async (...args: unknown[]) => {
                    const result = await (c.query as (...a: unknown[]) => Promise<unknown>)(...args);
                    // Every statement of a batch carries its timeout as `{ sql, timeout }`, COMMIT included.
                    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { sql: string }).sql;
                    if (text === 'COMMIT' && (commits += 1) === 3) controller.abort('SIGINT');
                    return result;
                  };
                },
              });
            };
          },
        });
        return { ...clients, mysql: { ...mysql, pool } };
      },
    });
    expect(interrupted.exitCode).toBe(130);
    const { value: partial } = await withMysql((mysql) => ledger(mysql));
    const loading = partial.filter((r) => r.status === 'loading');
    expect(loading.length).toBeGreaterThan(0);
    // A row stops at a committed batch boundary; a chunk whose last batch committed just before the interrupt
    // (the one-line rest chunk, say) holds every line and only lacks its `loaded` stamp. Both resume.
    for (const r of loading) {
      const done = Number(r.lines_done);
      expect(done % 7 === 0 || done === Number(r.exported_count), `${r.chunk_run_id} lines_done ${r.lines_done} of ${r.exported_count}`).toBe(true);
      expect(done).toBeLessThanOrEqual(Number(r.exported_count));
    }
    expect(loading.some((r) => Number(r.lines_done) < Number(r.exported_count))).toBe(true);

    // The delta's chunks were marked for replay in the ledger before the older batch wrote (the sentinel manifest
    // sha256), so a plain load, the one the closing hint suggests, resumes the older batch and replays them from
    // line 0 instead of skipping them as loaded; the older batch's own chunks resume from lines_done.
    const marked = partial.filter((r) => r.batch_id === D && Number(r.lines_done) > 0);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((r) => r.status === 'loading' && String(r.manifest_sha256).startsWith('replay-pending-'))).toBe(true);
    const resumed = await runLoad({ batchIds: [F, D] });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.events.some((e) => e.type === 'chunk' && e.status === 'done' && /resumed at \d+/.test(e.detail ?? ''))).toBe(true);
    expect(resumed.outcomes.filter((o) => o.chunk.startsWith(D) && o.status === 'done').length).toBeGreaterThan(0);
    const { value: rows } = await withMysql((mysql) => ledger(mysql));
    for (const r of rows) {
      expect(r.status, r.chunk_run_id).toBe('loaded');
      expect(Number(r.lines_done)).toBe(Number(r.exported_count));
      expect(Number(r.rows_inserted) + Number(r.rows_updated) + Number(r.duplicates_skipped) + Number(r.rows_rejected)).toBe(Number(r.exported_count));
    }
    expect((await runReconcile()).exitCode).toBe(0);
  });

  it('11. a deleted row is a table_count drift naming its key and chunk; --deep adds missing_rows; a reload repairs it', async () => {
    const victim = objectIdAt(auditCreatedAt('2026-03-02', 5).getTime(), 6).toHexString();
    await withMysql((mysql) => mysql.pool.query('DELETE FROM `audit_log_entries` WHERE `source_mongo_id` = ?', [victim]));
    const drifted = await runReconcile();
    expect(drifted.exitCode).toBe(4);
    expect(drifted.drifts.map((d) => d.kind)).toEqual(['table_count']);
    expect(drifted.drifts[0]).toMatchObject({ table: 'audit_log_entries', expected: 302, actual: 301 });
    expect(drifted.drifts[0]?.detail).toContain(victim);
    expect(drifted.drifts[0]?.detail).toContain(`${F}-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z`);

    const deep = await runReconcile({ deep: true });
    expect(deep.exitCode).toBe(4);
    expect(deep.drifts.map((d) => d.kind).sort()).toEqual(['missing_rows', 'table_count']);
    expect(deep.drifts.find((d) => d.kind === 'missing_rows')?.detail).toContain(victim);
    expect((await runReconcile({ deep: true, ignore: ['table_count', 'missing_rows'] })).exitCode).toBe(0);

    const repaired = await runLoad({ names: ['audit_log'], batchIds: [F, D], reload: true });
    expect(repaired.exitCode).toBe(0);
    expect((await runReconcile()).exitCode).toBe(0);
    const { value: back } = await withMysql((mysql) => sql(mysql, 'SELECT COUNT(*) AS c FROM `audit_log_entries` WHERE `source_mongo_id` = ?', [victim]));
    expect(Number(back[0]?.c)).toBe(1);

    const order = docs.orders.map((d) => d._id).find((id) => typeof id !== 'string');
    const orderHex = String(order);
    await withMysql((mysql) => mysql.pool.query('DELETE FROM `orders` WHERE `mongo_id` = ?', [orderHex]));
    const ordersDrift = await runReconcile({ names: ['orders'] });
    expect(ordersDrift.exitCode).toBe(4);
    expect(ordersDrift.drifts.map((d) => d.kind)).toEqual(['table_count']);
    expect(ordersDrift.drifts[0]?.detail).toMatch(new RegExp(`${orderHex} \\(${F}-orders-objectid-window-`));
    expect((await runLoad({ names: ['orders'], batchIds: [F, D], reload: true })).exitCode).toBe(0);
    expect((await runReconcile()).exitCode).toBe(0);
  });

  it('12. a rewritten part fails verify --all and is skipped as unverified by a reload', async () => {
    const first = (await listChunkManifests(probe, layout, 'audit_log', F)).find((m) => m.id.tail === 'window' && m.id.window?.start.toISOString().startsWith('2026-03-02'));
    const part = first?.parts[0];
    if (first === undefined || part === undefined) throw new Error('no first audit_log window');
    const lines = gunzipSync(await readAll((await probe.getStream(part.key as string)) as NodeJS.ReadableStream)).toString('utf8').split('\n');
    lines[1] = (lines[1] as string).replace(/"description" : "[^"]*"/, '"description" : "tampered after export"').replace(/"description":"[^"]*"/, '"description":"tampered after export"');
    const tampered = join(stack.workDir, 'tampered.jsonl.gz');
    await writeFile(tampered, gzipSync(lines.join('\n')));
    await probe.putFile(part.key as string, tampered, { contentType: 'application/gzip' });

    const verified = await runVerify({ all: true });
    expect(verified.exitCode).toBe(3);
    const damaged = verified.checks.filter((c) => !c.ok);
    expect(damaged.map((c) => c.runId)).toEqual([first.runId]);
    expect(damaged[0]?.errors.some((e) => /sha256|bytes/.test(e))).toBe(true);

    const reload = await runLoad({ batchIds: [F, D], reload: true });
    expect(reload.exitCode).toBe(2);
    const skipped = reload.outcomes.find((o) => o.chunk === first.runId);
    expect(skipped).toMatchObject({ status: 'skipped', note: 'unverified' });
    expect(reload.outcomes.filter((o) => o.status === 'done').length).toBe(reload.outcomes.length - 1);
  });

  it('13. the built CLI returns the same reconcile code, leaks no secret, and dry-runs an export', async () => {
    const inProcess = await runReconcile();
    const cli = await runCli(stack, ['reconcile']);
    expect(cli.code).toBe(inProcess.exitCode);
    expect(cli.stdout + cli.stderr).not.toContain(mysqlPassword);
    expect(cli.stdout + cli.stderr).not.toContain(mongoPassword);
    expect(cli.stdout).toContain('next:');

    const dry = await runCli(stack, ['export', '--dry-run']);
    expect(dry.stderr).toContain('dry run');
    expect(dry.code).toBe(0);
    expect(dry.stdout + dry.stderr).not.toContain(mysqlPassword);
    expect(dry.stdout + dry.stderr).not.toContain(mongoPassword);
    // A connection failure is where the driver would echo the URI: the message must carry the password redacted.
    const broken = await runCli({ ...stack, env: { ...stack.env, MSM_MONGO_URI: stack.mongoUri.replace('authSource=admin', 'authSource=admin&connectTimeoutMS=1500&serverSelectionTimeoutMS=1500').replace(mongoPassword, 'wrong-password-9f1') } }, ['export', '--dry-run']);
    expect(broken.code).toBe(1);
    expect(broken.stdout + broken.stderr).not.toContain('wrong-password-9f1');

    const json = await runCli(stack, ['--json', 'reconcile']);
    expect(json.code).toBe(inProcess.exitCode);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
  });
});
