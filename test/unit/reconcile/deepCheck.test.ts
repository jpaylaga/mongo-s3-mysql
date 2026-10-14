import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import listChunkManifests from '#layout/listChunkManifests';
import deepCheck from '#reconcile/deepCheck';
import tempDirOf from '#runtime/tempDirOf';
import type { ColumnInfo, ReconcileRun } from '#types';
import { exampleConfig, memoryContext, tmpDir } from '../../helpers.js';
import { fakePool } from '../mysql/fakeMysql.js';
import type { Rule } from '../mysql/fakeMysql.js';
import { twinMapping, twinTable } from '../mysql/fakeTables.js';
import seedArchive, { docLine, lines } from '../verify/seedArchive.js';
import { batchId, ledgerRow } from './fixtures.js';

const oid = (line: string): string => (JSON.parse(line) as { _id: { $oid: string } })._id.$oid;

async function setup(signal?: AbortSignal) {
  const stateDir = await tmpDir();

  const config = exampleConfig(
    { stateDir, retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 } },
    stateDir
  );

  const { ctx, store, layout, events } = memoryContext({ command: 'reconcile', config, signal });
  const seed = seedArchive(store, layout);

  return { ctx, store, layout, events, seed, config };
}

/**
 * The mysql side of the deep check: the temporary table statements, the inserts (captured) and
 * scripted counts.
 */
function scripted(counts: {
  distinct: number;
  missing?: number;
  unknown?: number;
  rejected?: { chunk_id: string; line_no: string }[];
}) {
  const inserted: string[] = [];

  const rules: Rule[] = [
    // One query per chunk, ascending line numbers: only that chunk's rejects are ever in memory.
    [
      /^SELECT `line_no` FROM `_msm_load_rejects` WHERE `chunk_id` = \? ORDER BY `line_no`$/,
      params =>
        (counts.rejected ?? [])
          .filter(r => r.chunk_id === String(params[0]))
          .map(r => ({ line_no: r.line_no })),
    ],
    [/^DROP TEMPORARY TABLE IF EXISTS `_msm_ids`$/, []],
    [
      new RegExp(
        '^CREATE TEMPORARY TABLE `_msm_ids` ' +
          '\\(`id` VARCHAR\\(760\\) COLLATE utf8mb4_0900_bin PRIMARY KEY\\)$'
      ),
      [],
    ],
    [
      /^INSERT IGNORE INTO `_msm_ids` \(`id`\) VALUES \?$/,
      params => {
        inserted.push(...(params[0] as string[][]).map(r => r[0] as string));

        return [];
      },
    ],
    [/^SELECT COUNT\(\*\) AS c FROM `_msm_ids`$/, [{ c: String(counts.distinct) }]],
    [/^SELECT COUNT\(\*\) AS c FROM `_msm_ids` i LEFT JOIN/, [{ c: String(counts.missing ?? 0) }]],
    [
      /^SELECT i\.`id` AS id FROM `_msm_ids` i LEFT JOIN .* ORDER BY i\.`id` LIMIT 20$/,
      [{ id: 'missing-1' }, { id: 'missing-2' }],
    ],
    [
      /^SELECT COUNT\(\*\) AS c FROM `audit_log_entries` WHERE .* NOT EXISTS/,
      [{ c: String(counts.unknown ?? 0) }],
    ],
    [
      /^SELECT `audit_log_entries`\.`source_mongo_id` AS k FROM .* NOT EXISTS .* LIMIT 20$/,
      [{ k: 'stray-1' }],
    ],
  ];

  return { rules, inserted };
}

describe('deepCheck', () => {
  it('loads every key into one temp table in batches and proves missing/unknown rows', async () => {
    const { ctx, store, layout, seed, config } = await setup();
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(5), partSize: 2 });

    const b = await seed.chunk({
      collection: 'audit_log',
      batchId,
      mode: 'full-collection',
      tail: 'rest',
      lines: lines(3, 6),
    });

    await seed.chunk({
      collection: 'audit_log',
      batchId,
      mode: 'objectid-window',
      lines: lines(2, 20),
    }); // no ledger row: not read

    const manifests = await listChunkManifests(store, layout, 'audit_log', batchId);

    expect(manifests).toHaveLength(3);

    const { rules, inserted } = scripted({ distinct: 8, missing: 2, unknown: 1 });
    const { mysql, sqls, released } = fakePool(rules);
    const run: ReconcileRun = { ctx, store, layout, mysql };

    const selected = [
      ledgerRow({ id: 1, chunk_run_id: a.runId }),
      ledgerRow({ id: 2, chunk_run_id: b.runId }),
    ];

    const result = await deepCheck(run, twinMapping(), twinTable(), selected, manifests, true);

    expect(result.distinct).toBe(8);
    expect(inserted).toEqual([...lines(5), ...lines(3, 6)].map(oid));

    expect(result.drifts).toEqual([
      {
        table: 'audit_log_entries',
        kind: 'missing_rows',
        chunk: null,
        expected: 8,
        actual: 6,
        detail: '2 ids in the archived parts have no row: missing-1, missing-2',
      },
      {
        table: 'audit_log_entries',
        kind: 'unknown_rows',
        chunk: null,
        expected: 0,
        actual: 1,
        detail: '1 keyed rows carry a key no part of any loaded batch holds: stray-1',
      },
    ]);

    const statements = sqls();

    expect(statements[0]).toMatch(/^DROP TEMPORARY/);
    expect(statements[1]).toMatch(/^CREATE TEMPORARY/);

    expect(
      statements.filter(s => s.startsWith('SELECT `line_no` FROM `_msm_load_rejects`'))
    ).toHaveLength(2);

    expect(statements[statements.length - 1]).toMatch(/^DROP TEMPORARY/);

    // The anti-join converts the temporary ids to the key column's collation; the NOT EXISTS
    // converts the key to the ledger's.
    expect(statements.find(s => s.includes('LEFT JOIN'))).toContain(
      'ON `audit_log_entries`.`source_mongo_id` = CONVERT(i.`id` USING utf8mb4) ' +
        'COLLATE utf8mb4_0900_ai_ci WHERE `audit_log_entries`.`source_mongo_id` IS ' +
        'NULL'
    );

    expect(statements.find(s => s.includes('NOT EXISTS'))).toContain(
      'WHERE i.`id` = CONVERT(`audit_log_entries`.`source_mongo_id` USING utf8mb4) ' +
        'COLLATE utf8mb4_0900_bin'
    );

    expect(released()).toBe(1);
    await expect(access(join(tempDirOf(config, 'reconcile'), a.runId))).rejects.toThrow();
    expect(await readdir(tempDirOf(config, 'reconcile'))).toEqual([]);
  });

  it("skips lines the load rejected and lines past an unfinished chunk's lines_done", async () => {
    const { ctx, store, layout, seed } = await setup();
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(4) });

    const b = await seed.chunk({
      collection: 'audit_log',
      batchId,
      mode: 'full-collection',
      tail: 'rest',
      lines: lines(3, 10),
    });

    const manifests = await listChunkManifests(store, layout, 'audit_log', batchId);

    // Chunk 1 rejected its second line (a cast error); chunk 2 was interrupted after one line.
    const { rules, inserted } = scripted({
      distinct: 4,
      rejected: [{ chunk_id: '1', line_no: '2' }],
    });

    const { mysql, calls } = fakePool(rules);

    const selected = [
      ledgerRow({ id: 1, chunk_run_id: a.runId, rows_rejected: 1 }),
      ledgerRow({ id: 2, chunk_run_id: b.runId, status: 'loading', lines_done: 1 }),
    ];

    await deepCheck(
      { ctx, store, layout, mysql },
      twinMapping(),
      twinTable(),
      selected,
      manifests,
      false
    );

    expect(inserted).toEqual([docLine(1), docLine(3), docLine(4), docLine(10)].map(oid));

    expect(calls.filter(c => c.sql.includes('_msm_load_rejects')).map(c => c.params)).toEqual([
      [1],
      [2],
    ]);
  });

  it('several rejected lines of one chunk, in any order, are each skipped once', async () => {
    const { ctx, store, layout, seed } = await setup();
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(6) });
    const manifests = await listChunkManifests(store, layout, 'audit_log', batchId);

    const { rules, inserted } = scripted({
      distinct: 3,
      rejected: [
        { chunk_id: '1', line_no: '1' },
        { chunk_id: '1', line_no: '4' },
        { chunk_id: '1', line_no: '5' },
        { chunk_id: '9', line_no: '2' },
      ],
    });

    const { mysql } = fakePool(rules);

    await deepCheck(
      { ctx, store, layout, mysql },
      twinMapping(),
      twinTable(),
      [ledgerRow({ id: 1, chunk_run_id: a.runId, rows_rejected: 3 })],
      manifests,
      false
    );

    expect(inserted).toEqual([docLine(2), docLine(3), docLine(6)].map(oid));
  });

  it('an over-long key ends the check instead of being truncated into false drifts', async () => {
    const { ctx, store, layout, seed } = await setup();
    const long = `{ "_id" : "${'a'.repeat(760)}X" }`;
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: [docLine(1), long] });
    const manifests = await listChunkManifests(store, layout, 'audit_log', batchId);
    const { rules, inserted } = scripted({ distinct: 0 });
    const { mysql, released } = fakePool(rules);

    const stringKey = {
      ...twinMapping(),
      key: { column: 'source_mongo_id', cast: 'string' as const },
    };

    // A key column wide enough to hold the value (keyLedger off is the one configuration where the
    // shape check lets it through).
    const wide = twinTable();

    wide.columns.set('source_mongo_id', {
      ...(wide.columns.get('source_mongo_id') as ColumnInfo),
      dataType: 'varchar',
      collation: 'utf8mb4_0900_bin',
      charLength: 2000,
      octetLength: 8000,
    });

    await expect(
      deepCheck(
        { ctx, store, layout, mysql },
        stringKey,
        wide,
        [ledgerRow({ chunk_run_id: a.runId })],
        manifests,
        true
      )
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message:
        `audit_log_entries.source_mongo_id: line 2 of ${a.runId} has a key of 761 ` +
        'characters; keys over 760 cannot be deep-checked (the id table would ' +
        'truncate and merge them)',
    });

    expect(inserted).toEqual([]);
    expect(released()).toBe(1);
  });

  it('skips NOT EXISTS unless the whole ledger is selected; releases its connection', async () => {
    const { ctx, store, layout, seed } = await setup();
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(2) });
    const manifests = await listChunkManifests(store, layout, 'audit_log', batchId);
    const { rules } = scripted({ distinct: 2 });
    const { mysql, sqls, released } = fakePool(rules);

    const result = await deepCheck(
      { ctx, store, layout, mysql },
      twinMapping(),
      twinTable(),
      [ledgerRow({ chunk_run_id: a.runId })],
      manifests,
      false
    );

    expect(result).toEqual({ drifts: [], distinct: 2 });
    expect(sqls().some(s => s.includes('NOT EXISTS'))).toBe(false);
    expect(released()).toBe(1);
  });

  it('skips lines load would have rejected and flushes in batches of 1,000', async () => {
    const { ctx, store, layout, seed } = await setup();
    const many = lines(1_001);

    const a = await seed.chunk({
      collection: 'audit_log',
      batchId,
      lines: [...many, '{ "_id" : "legacy-7" }', 'not json', docLine(5000)],
    });

    const manifests = await listChunkManifests(store, layout, 'audit_log', batchId);
    const { rules, inserted } = scripted({ distinct: 1_002 });
    const { mysql, calls } = fakePool(rules);

    await deepCheck(
      { ctx, store, layout, mysql },
      twinMapping(),
      twinTable(),
      [ledgerRow({ chunk_run_id: a.runId })],
      manifests,
      true
    );

    expect(inserted).toEqual([...many, docLine(5000)].map(oid));

    const inserts = calls.filter(c => c.sql.startsWith('INSERT IGNORE'));

    expect(inserts.map(c => (c.params[0] as unknown[]).length)).toEqual([1_000, 2]);
  });

  it('a part whose bytes or sha256 differ ends the check before any line is trusted', async () => {
    const { ctx, store, layout, seed } = await setup();
    const good = lines(2);

    const a = await seed.chunk({
      collection: 'audit_log',
      batchId,
      lines: good,
      objects: [Buffer.from('not the part')],
    });

    const manifests = await listChunkManifests(store, layout, 'audit_log', batchId);
    const { rules, inserted } = scripted({ distinct: 0 });
    const { mysql, sqls, released } = fakePool(rules);

    await expect(
      deepCheck(
        { ctx, store, layout, mysql },
        twinMapping(),
        twinTable(),
        [ledgerRow({ chunk_run_id: a.runId })],
        manifests,
        true
      )
    ).rejects.toMatchObject({
      msmCode: 'sha256',
      message: expect.stringMatching(/bytes, manifest says/),
    });

    expect(inserted).toEqual([]);
    expect(sqls()[sqls().length - 1]).toMatch(/^DROP TEMPORARY/);
    expect(released()).toBe(1);
  });

  it('stops between parts when the run is aborted', async () => {
    const controller = new AbortController();
    const { ctx, store, layout, seed } = await setup(controller.signal);
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(2) });
    const manifests = await listChunkManifests(store, layout, 'audit_log', batchId);
    const { mysql } = fakePool(scripted({ distinct: 0 }).rules);

    controller.abort('SIGINT');

    await expect(
      deepCheck(
        { ctx, store, layout, mysql },
        twinMapping(),
        twinTable(),
        [ledgerRow({ chunk_run_id: a.runId })],
        manifests,
        true
      )
    ).rejects.toMatchObject({ msmCode: 'interrupted' });
  });
});
