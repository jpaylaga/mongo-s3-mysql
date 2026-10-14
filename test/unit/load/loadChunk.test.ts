import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import listChunkManifests from '../../../src/layout/listChunkManifests.js';
import loadChunk from '../../../src/load/loadChunk.js';
import tempDirOf from '../../../src/runtime/tempDirOf.js';
import type { LoadRun, MsmEvent, ResolvedManifest } from '../../../src/types.js';
import { exampleConfig, memoryContext, tmpDir } from '../../helpers.js';
import seedArchive, { lines } from '../verify/seedArchive.js';
import { fakeMysql, header, tupleCount, type Rule } from '../mysql/fakeMysql.js';
import { batchId, mappingSha, simpleMapping, simpleTable, target } from './fixtures.js';

type LedgerState = { id?: number; status?: 'loading' | 'loaded' | 'failed'; linesDone?: number; manifestSha256?: string; mappingSha256?: string };

/** The ledger as one chunk sees it; the SELECT answers from `state`, which a test sets to the row's history. */
function ledgerRules(state: LedgerState, resolvedSha: () => string): Rule[] {
  return [
    [/^INSERT IGNORE INTO `_msm_load_chunks`/, header(1)],
    [/^SELECT `id`, `status`, `lines_done`, `manifest_sha256`, `mapping_sha256` FROM `_msm_load_chunks`/, () => [{
      id: String(state.id ?? 7), status: state.status ?? 'loading', lines_done: String(state.linesDone ?? 0),
      manifest_sha256: state.manifestSha256 ?? resolvedSha(), mapping_sha256: state.mappingSha256 ?? mappingSha,
    }]],
    [/^UPDATE `_msm_load_chunks` SET `lines_done` = 0, `rows_inserted` = 0/, header(1)],
    [/^DELETE FROM `_msm_load_(rejects|keys)` WHERE `chunk_id` = \? LIMIT 10000$/, header(0)],
    [/^UPDATE `_msm_load_chunks` SET `status` = 'loading', `attempts` = `attempts` \+ 1/, header(1)],
    [/^START TRANSACTION$/, header(0)],
    [/FOR UPDATE$/, []],
    [/^INSERT INTO `audit_log_entries` /, (_p, sql) => header(tupleCount(sql), `Records: ${tupleCount(sql)}  Duplicates: 0  Warnings: 0`)],
    [/^INSERT IGNORE INTO `_msm_load_(rejects|keys)`/, header(0)],
    [/^UPDATE `_msm_load_chunks` SET `lines_done` = \?/, header(1)],
    [/^COMMIT$/, header(0)],
    [/^ROLLBACK$/, header(0)],
    [/^UPDATE `_msm_load_chunks` SET `status` = 'loaded'/, header(1)],
  ];
}

async function setup(options: { state?: LedgerState; lockHeld?: boolean; lockQueryError?: Error; rules?: Rule[]; batchRows?: number; keyLedger?: boolean; signal?: AbortSignal } = {}) {
  const dir = await tmpDir();
  const config = exampleConfig({ stateDir: dir, minFreeDiskMb: 0, retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 }, load: { batchRows: options.batchRows ?? 1000, keyLedger: options.keyLedger ?? true } }, dir);
  // A fixed clock: the done event prints the duration, which must not depend on how busy the machine is.
  const mc = memoryContext({ command: 'load', config, signal: options.signal, now: () => new Date('2026-10-13T04:00:00Z') });
  const seed = seedArchive(mc.store, mc.layout);
  let current: ResolvedManifest | null = null;
  const fake = fakeMysql([
    [/^SELECT IS_USED_LOCK\(\?\) = CONNECTION_ID\(\) AS held$/, () => { if (options.lockQueryError) throw options.lockQueryError; return [{ held: options.lockHeld === false ? 0 : 1 }]; }],
    ...(options.rules ?? []),
    ...ledgerRules(options.state ?? {}, () => current?.sha256 ?? ''),
  ]);
  const lockConn = await fake.mysql.connect();
  const tgt = target(simpleMapping(), simpleTable());
  const run: LoadRun = {
    ctx: mc.ctx, store: mc.store, mysql: fake.mysql, loadRunId: 'load-20261013T040000Z', maxBatchBytes: 1024 * 1024, maxRowBytes: 1024 * 1024,
    targets: new Map([['audit_log', tgt]]), locks: new Map([['audit_log_entries', { conn: lockConn, name: 'msm:abc', release: async () => undefined, destroy: () => { fake.counts.lockDestroyed += 1; } }]]),
    batchCutoffs: new Map([[batchId, '2026-10-13T01:00:00Z']]),
  };
  const resolve = async (spec: Parameters<typeof seed.chunk>[0]): Promise<ResolvedManifest> => {
    const { runId } = await seed.chunk(spec);
    const r = (await listChunkManifests(mc.store, mc.layout, spec.collection, spec.batchId)).find((m) => m.runId === runId) as ResolvedManifest;
    current = r;
    return r;
  };
  const chunkEvents = () => mc.events.filter((e): e is Extract<MsmEvent, { type: 'chunk' }> => e.type === 'chunk').map((e) => `${e.status}${e.detail ? `: ${e.detail}` : ''}`);
  return { ...mc, ...fake, run, resolve, dir, chunkEvents };
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

describe('loadChunk', () => {
  it('registers the row, resets a fresh one, streams the part through writeBatch and marks the chunk loaded', async () => {
    const { run, resolve, sqls, calls, chunkEvents, dir } = await setup();
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(3) });
    const outcome = await loadChunk(run, { resolved: r, reload: false }, 1);
    expect(outcome).toEqual({ chunk: r.runId, collection: 'audit_log', status: 'done', docs: 3 });
    const s = sqls();
    expect(s[0]).toMatch(/^SELECT IS_USED_LOCK/);
    expect(s[1]).toMatch(/^INSERT IGNORE INTO `_msm_load_chunks` \(`target_table`, `collection`, `batch_id`, `chunk_run_id`, `batch_cutoff_utc`, `manifest_key`, `manifest_sha256`, `mapping_sha256`, `exported_count`, `load_run_id`, `started_at`, `updated_at`\)/);
    expect(calls[1]?.params).toEqual(['audit_log_entries', 'audit_log', batchId, r.runId, '2026-10-13T01:00:00Z', r.key, r.sha256, mappingSha, 3, 'load-20261013T040000Z']);
    // A row at lines_done 0 always runs the reset deletes, so an interrupted reset completes.
    expect(s.slice(2, 7)).toEqual([
      expect.stringMatching(/^SELECT `id`, `status`, `lines_done`/),
      expect.stringMatching(/^UPDATE `_msm_load_chunks` SET `lines_done` = 0/),
      'DELETE FROM `_msm_load_rejects` WHERE `chunk_id` = ? LIMIT 10000',
      'DELETE FROM `_msm_load_keys` WHERE `chunk_id` = ? LIMIT 10000',
      expect.stringMatching(/^UPDATE `_msm_load_chunks` SET `status` = 'loading', `attempts` = `attempts` \+ 1, `load_run_id` = \?/),
    ]);
    // The attempt stamp refreshes count, key and cutoff too, so a re-exported or late-registered chunk's row stays current.
    expect(calls[6]?.params).toEqual(['load-20261013T040000Z', r.sha256, mappingSha, 3, r.key, '2026-10-13T01:00:00Z', 7]);
    const insert = s.find((x) => x.startsWith('INSERT INTO `audit_log_entries`')) as string;
    expect(tupleCount(insert)).toBe(3);
    expect(insert).toMatch(/VALUES \('69a4d3025a5a5a0000000001', 1\),\('69a4d3035a5a5a0000000002', 2\),\('69a4d3045a5a5a0000000003', 3\) AS/);
    expect(calls.find((c) => c.sql.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = ?'))?.params).toEqual([3, 3, 0, 0, 0, 0, 7]);
    expect(s.at(-1)).toMatch(/^UPDATE `_msm_load_chunks` SET `status` = 'loaded', `error` = NULL, `finished_at` = UTC_TIMESTAMP\(3\)/);
    expect(calls.at(-1)?.params).toEqual([7]);
    expect(chunkEvents()).toEqual(['start', 'part: part-000001.jsonl.gz 3 lines read', 'done: 3 lines: 3 inserted, 0 updated, 0 rejected (0.0s)']);
    expect(await exists(join(tempDirOf(run.ctx.config, 'load'), r.runId))).toBe(false);
  });

  it('resumes at lines_done: lines already committed are skipped and only the rest is written', async () => {
    const { run, resolve, sqls, calls, chunkEvents } = await setup({ state: { status: 'loading', linesDone: 2 } });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(3) });
    const outcome = await loadChunk(run, { resolved: r, reload: false }, 2);
    expect(outcome).toMatchObject({ status: 'done', docs: 1 });
    expect(sqls().some((x) => x.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = 0'))).toBe(false);
    const insert = sqls().find((x) => x.startsWith('INSERT INTO `audit_log_entries`')) as string;
    expect(tupleCount(insert)).toBe(1);
    expect(insert).toContain("('69a4d3045a5a5a0000000003', 3)");
    expect(calls.find((c) => c.sql.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = ?'))?.params).toEqual([3, 1, 0, 0, 0, 0, 7]);
    expect(chunkEvents()[0]).toBe('start: attempt 2');
    expect(chunkEvents().at(-1)).toBe('done: 1 lines: 1 inserted, 0 updated, 0 rejected (resumed at 2) (0.0s)');
  });

  it('skips whole parts that lines_done already covers and continues inside the next one', async () => {
    const { run, resolve, sqls, store } = await setup({ state: { status: 'loading', linesDone: 5 } });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(9), partSize: 4 });
    expect(r.parts).toHaveLength(3);
    // Remove the first part: a correct resume never reads it.
    store.objects.delete(r.parts[0]?.key as string);
    const outcome = await loadChunk(run, { resolved: r, reload: false }, 1);
    expect(outcome).toMatchObject({ status: 'done', docs: 4 });
    const inserts = sqls().filter((x) => x.startsWith('INSERT INTO `audit_log_entries`'));
    expect(inserts.map(tupleCount)).toEqual([4]);
    expect(inserts[0]).toContain("('69a4d3075a5a5a0000000006', 6)");
    expect(inserts[0]).not.toContain('0000000005');
  });

  it('writes one transaction per batchRows lines, advancing lines_done each time', async () => {
    const { run, resolve, calls } = await setup({ batchRows: 2 });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(5) });
    await loadChunk(run, { resolved: r, reload: false }, 1);
    const advances = calls.filter((c) => c.sql.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = ?')).map((c) => c.params[0]);
    expect(advances).toEqual([2, 4, 5]);
    expect(calls.filter((c) => c.sql === 'COMMIT')).toHaveLength(3);
  });

  it('a loaded row without --reload is skipped before any write', async () => {
    const { run, resolve, sqls, chunkEvents } = await setup({ state: { status: 'loaded', linesDone: 3 } });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(3) });
    expect(await loadChunk(run, { resolved: r, reload: false }, 1)).toEqual({ chunk: r.runId, collection: 'audit_log', status: 'skipped', note: 'already loaded' });
    expect(sqls().filter((x) => x.startsWith('UPDATE') || x.startsWith('DELETE') || x.startsWith('INSERT INTO'))).toEqual([]);
    expect(chunkEvents()).toEqual(['start', 'skipped: already loaded']);
  });

  it('--reload resets a loaded row (counters, rejects and keys) and loads every line again', async () => {
    const { run, resolve, sqls, calls } = await setup({ state: { status: 'loaded', linesDone: 3 } });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(3) });
    expect(await loadChunk(run, { resolved: r, reload: true }, 1)).toMatchObject({ status: 'done', docs: 3 });
    const reset = calls.find((c) => c.sql.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = 0'));
    expect(reset?.sql).toContain("`status` = 'loading', `manifest_sha256` = ?, `mapping_sha256` = ?, `finished_at` = NULL, `error` = NULL");
    expect(reset?.params).toEqual([r.sha256, mappingSha, 7]);
    expect(sqls().filter((x) => x.startsWith('DELETE FROM'))).toEqual(['DELETE FROM `_msm_load_rejects` WHERE `chunk_id` = ? LIMIT 10000', 'DELETE FROM `_msm_load_keys` WHERE `chunk_id` = ? LIMIT 10000']);
    expect(tupleCount(sqls().find((x) => x.startsWith('INSERT INTO `audit_log_entries`')) as string)).toBe(3);
  });

  it('reload on a loading row (the order guard forcing a replay) restarts from line 0, and only on the attempt that reset it', async () => {
    const { run, resolve, sqls } = await setup({ state: { status: 'loading', linesDone: 2 } });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(3) });
    const cand = { resolved: r, reload: true };
    expect(await loadChunk(run, cand, 1)).toMatchObject({ status: 'done', docs: 3 });
    expect(sqls().some((x) => x.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = 0'))).toBe(true);
    expect(tupleCount(sqls().find((x) => x.startsWith('INSERT INTO `audit_log_entries`')) as string)).toBe(3);
    // The reset met the obligation: a later attempt of the same candidate resumes at lines_done instead of replaying.
    expect(cand.reload).toBe(false);
  });

  it('a reload whose first attempt fails after committing resumes at lines_done on the next attempt instead of starting over', async () => {
    const boom = Object.assign(new Error('Deadlock found'), { errno: 1213, sqlState: '40001' });
    let inserts = 0;
    const state: LedgerState = { status: 'loaded', linesDone: 5 };
    const rules: Rule[] = [
      [/^INSERT INTO `audit_log_entries`/, (_p, sql) => {
        inserts += 1;
        if (inserts === 2) throw boom;
        return header(tupleCount(sql), `Records: ${tupleCount(sql)}  Duplicates: 0  Warnings: 0`);
      }],
      [/^UPDATE `_msm_load_chunks` SET `lines_done` = \?/, (params) => { state.linesDone = params[0] as number; return header(1); }],
      [/^UPDATE `_msm_load_chunks` SET `lines_done` = 0/, () => { state.linesDone = 0; state.status = 'loading'; return header(1); }],
    ];
    const { run, resolve, calls } = await setup({ rules, batchRows: 2, state });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(5) });
    const cand = { resolved: r, reload: true };
    await expect(loadChunk(run, cand, 1)).rejects.toBe(boom);
    expect(state.linesDone).toBe(2);
    expect(cand.reload).toBe(false);
    expect(await loadChunk(run, cand, 2)).toMatchObject({ status: 'done', docs: 3 });
    expect(calls.filter((c) => c.sql.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = 0'))).toHaveLength(1);
    const advances = calls.filter((c) => c.sql.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = ?')).map((c) => c.params[0]);
    expect(advances).toEqual([2, 4, 5]);
  });

  it('a loading row recorded under another manifest sha256 restarts from line 0 with the current shas', async () => {
    const { run, resolve, sqls, calls } = await setup({ state: { status: 'loading', linesDone: 2, manifestSha256: 'c'.repeat(64) } });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(3) });
    expect(await loadChunk(run, { resolved: r, reload: false }, 1)).toMatchObject({ status: 'done', docs: 3 });
    expect(calls.find((c) => c.sql.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = 0'))?.params).toEqual([r.sha256, mappingSha, 7]);
    expect(tupleCount(sqls().find((x) => x.startsWith('INSERT INTO `audit_log_entries`')) as string)).toBe(3);
  });

  it('a loading row recorded under another mapping sha256 restarts the same way', async () => {
    const { run, resolve, sqls } = await setup({ state: { status: 'loading', linesDone: 2, mappingSha256: 'c'.repeat(64) } });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(3) });
    await loadChunk(run, { resolved: r, reload: false }, 1);
    expect(sqls().some((x) => x.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = 0'))).toBe(true);
    expect(tupleCount(sqls().find((x) => x.startsWith('INSERT INTO `audit_log_entries`')) as string)).toBe(3);
  });

  it('reset deletes page through the chunk rows until a page comes back short', async () => {
    const pages: number[] = [10_000, 10_000, 3];
    const rules: Rule[] = [[/^DELETE FROM `_msm_load_rejects`/, () => header(pages.shift() ?? 0)]];
    const { run, resolve, sqls } = await setup({ rules });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(1) });
    await loadChunk(run, { resolved: r, reload: false }, 1);
    expect(sqls().filter((x) => x.startsWith('DELETE FROM `_msm_load_rejects`'))).toHaveLength(3);
    expect(sqls().filter((x) => x.startsWith('DELETE FROM `_msm_load_keys`'))).toHaveLength(1);
  });

  it('without the key ledger the reset leaves _msm_load_keys alone', async () => {
    const { run, resolve, sqls } = await setup({ keyLedger: false });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(1) });
    await loadChunk(run, { resolved: r, reload: false }, 1);
    expect(sqls().some((x) => x.includes('_msm_load_keys'))).toBe(false);
  });

  it('a lost table lock is fatal before the ledger is touched, including when the lock connection itself failed', async () => {
    const { run, resolve, sqls, calls, counts } = await setup({ lockHeld: false });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(1) });
    await expect(loadChunk(run, { resolved: r, reload: false }, 1)).rejects.toMatchObject({ msmCode: 'lock', fatal: true, message: 'lock on audit_log_entries lost' });
    expect(sqls()).toHaveLength(1);
    // The check carries the 30 s timeout, and a lost lock tears the holder connection down so nothing queues behind it.
    expect(calls[0]?.timeout).toBe(30_000);
    expect(counts.lockDestroyed).toBe(1);
    // mysql2's closed-connection error has no code; it must not be retried as an unknown chunk failure.
    const dropped = await setup({ lockQueryError: Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true }) });
    await expect(loadChunk(dropped.run, { resolved: r, reload: false }, 1)).rejects.toMatchObject({ msmCode: 'lock', fatal: true, message: "lock on audit_log_entries lost: Can't add new command when connection is in closed state" });
    expect(dropped.counts.lockDestroyed).toBe(1);
    const { run: noLock } = await setup();
    noLock.locks.clear();
    await expect(loadChunk(noLock, { resolved: r, reload: false }, 1)).rejects.toMatchObject({ msmCode: 'lock', fatal: true, message: 'lock on audit_log_entries was never taken' });
  });

  it('a collection without a target is a fatal config error', async () => {
    const { run, resolve } = await setup();
    const r = await resolve({ collection: 'orders', batchId, mode: 'objectid-window', lines: lines(1) });
    await expect(loadChunk(run, { resolved: r, reload: false }, 1)).rejects.toMatchObject({ msmCode: 'config', fatal: true, message: 'orders: no load target' });
  });

  it('a part with more or fewer lines than exported_count is a record error after the data is written', async () => {
    const { run, resolve } = await setup();
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(3), manifest: { exported_count: 4, source_count: 4 } });
    await expect(loadChunk(run, { resolved: r, reload: false }, 1)).rejects.toMatchObject({ msmCode: 'record', message: `${r.runId}: read 3 lines, manifest says exported_count 4` });
  });

  it('bad lines become rejects in the same transaction and count in the outcome detail', async () => {
    const { run, resolve, sqls, calls, chunkEvents } = await setup();
    const r = await resolve({ collection: 'audit_log', batchId, lines: [...lines(2), '{ broken', '{ "_id" : "not-an-oid" }'] });
    expect(await loadChunk(run, { resolved: r, reload: false }, 1)).toMatchObject({ status: 'done', docs: 4 });
    const rejects = sqls().find((x) => x.startsWith('INSERT IGNORE INTO `_msm_load_rejects`')) as string;
    expect(rejects).toMatch(/VALUES \(7,3,'invalid JSON: .*?','\{ broken',UTC_TIMESTAMP\(3\)\),\(7,4,'_id: not an ObjectId: a string','\{ \\"_id\\" : \\"not-an-oid\\" \}',UTC_TIMESTAMP\(3\)\)$/);
    expect(calls.find((c) => c.sql.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = ?'))?.params).toEqual([4, 2, 0, 0, 2, 0, 7]);
    expect(chunkEvents().at(-1)).toBe('done: 4 lines: 2 inserted, 0 updated, 2 rejected (0.0s)');
  });

  it('a manifest-only chunk is marked loaded with no data statements', async () => {
    const { run, resolve, sqls, chunkEvents } = await setup();
    const r = await resolve({ collection: 'audit_log', batchId, mode: 'manifest-only' });
    expect(r.parts).toEqual([]);
    expect(await loadChunk(run, { resolved: r, reload: false }, 1)).toEqual({ chunk: r.runId, collection: 'audit_log', status: 'done', docs: 0 });
    expect(sqls().some((x) => x === 'START TRANSACTION' || x.startsWith('INSERT INTO `audit_log_entries`'))).toBe(false);
    expect(sqls().at(-1)).toMatch(/SET `status` = 'loaded'/);
    expect(chunkEvents().at(-1)).toBe('done: no documents, ledger only');
  });

  it('a failing batch leaves the ledger at its last commit and propagates the error for the chunk retry', async () => {
    const boom = Object.assign(new Error('Deadlock found'), { errno: 1213, sqlState: '40001' });
    let inserts = 0;
    const rules: Rule[] = [[/^INSERT INTO `audit_log_entries`/, (_p, sql) => {
      inserts += 1;
      if (inserts === 2) throw boom;
      return header(tupleCount(sql), `Records: ${tupleCount(sql)}  Duplicates: 0  Warnings: 0`);
    }]];
    const { run, resolve, calls, dir } = await setup({ rules, batchRows: 2 });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(5) });
    await expect(loadChunk(run, { resolved: r, reload: false }, 1)).rejects.toBe(boom);
    expect(calls.filter((c) => c.sql === 'COMMIT')).toHaveLength(1);
    expect(calls.filter((c) => c.sql === 'ROLLBACK')).toHaveLength(1);
    expect(calls.some((c) => c.sql.includes("`status` = 'loaded'"))).toBe(false);
    expect(await exists(join(tempDirOf(run.ctx.config, 'load'), r.runId))).toBe(false);
  });

  it('an abort between batches ends the chunk as interrupted without the final status update', async () => {
    const controller = new AbortController();
    const rules: Rule[] = [[/^COMMIT$/, () => { controller.abort('SIGINT'); return header(0); }]];
    const { run, resolve, calls } = await setup({ rules, batchRows: 2, signal: controller.signal });
    const r = await resolve({ collection: 'audit_log', batchId, lines: lines(5) });
    await expect(loadChunk(run, { resolved: r, reload: false }, 1)).rejects.toMatchObject({ msmCode: 'interrupted' });
    expect(calls.filter((c) => c.sql === 'COMMIT')).toHaveLength(1);
    expect(calls.some((c) => c.sql.includes("`status` = 'loaded'"))).toBe(false);
  });
});
