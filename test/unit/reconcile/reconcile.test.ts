import { access, chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import exitCodes from '#cli/exitCodes';
import reconcile from '#reconcile/reconcile';
import acquireLock from '#runtime/acquireLock';
import tempDirOf from '#runtime/tempDirOf';
import type { CollectionConfig, LedgerRow, MsmEvent } from '#types';
import { exampleConfig, memoryContext, tmpDir } from '../../helpers.js';
import { fakePool } from '../mysql/fakeMysql.js';
import type { Rule } from '../mysql/fakeMysql.js';
import seedArchive, { lines } from '../verify/seedArchive.js';
import { batchId, ledgerRow } from './fixtures.js';

const twinMappingJson = {
  collection: 'audit_log',
  table: 'audit_log_entries',
  key: { column: 'source_mongo_id', cast: 'objectId' },
  runIdColumn: 'backfill_run_id',
  columns: [{ column: 'actor_id', source: 'actor_id', cast: 'string', default: '' }],
};

/** information_schema as readTableInfo queries it, for the twin table's key and id columns only. */
const schemaRules: Rule[] = [
  [
    /FROM information_schema\.COLUMNS/,
    params =>
      params[1] === 'audit_log_entries'
        ? [
            {
              COLUMN_NAME: 'id',
              DATA_TYPE: 'bigint',
              COLUMN_TYPE: 'bigint unsigned',
              IS_NULLABLE: 'NO',
              COLUMN_DEFAULT: null,
              EXTRA: 'auto_increment',
              COLLATION_NAME: null,
              CHARACTER_MAXIMUM_LENGTH: null,
              CHARACTER_OCTET_LENGTH: null,
              NUMERIC_PRECISION: '20',
              NUMERIC_SCALE: '0',
              DATETIME_PRECISION: null,
            },
            {
              COLUMN_NAME: 'source_mongo_id',
              DATA_TYPE: 'char',
              COLUMN_TYPE: 'char(24)',
              IS_NULLABLE: 'YES',
              COLUMN_DEFAULT: null,
              EXTRA: '',
              COLLATION_NAME: 'utf8mb4_0900_ai_ci',
              CHARACTER_MAXIMUM_LENGTH: '24',
              CHARACTER_OCTET_LENGTH: '96',
              NUMERIC_PRECISION: null,
              NUMERIC_SCALE: null,
              DATETIME_PRECISION: null,
            },
          ]
        : [],
  ],
  [
    /FROM information_schema\.STATISTICS/,
    [
      { INDEX_NAME: 'PRIMARY', NON_UNIQUE: '0', SEQ_IN_INDEX: '1', COLUMN_NAME: 'id' },
      { INDEX_NAME: 'uq', NON_UNIQUE: '0', SEQ_IN_INDEX: '1', COLUMN_NAME: 'source_mongo_id' },
    ],
  ],
];

const ledgerRule = (rows: LedgerRow[]): Rule => [
  /FROM `_msm_load_chunks` WHERE `target_table`/,
  rows.map(r =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])
    )
  ),
];

const tableRules = (keyed: number, expected: number, missing: number): Rule[] => [
  [/AS keyed, COUNT\(\*\) - COUNT/, [{ keyed: String(keyed), untracked: '0' }]],
  // Every selected chunk recorded at least as many keys as it inserted.
  [
    /COUNT\(\*\) AS key_rows FROM `_msm_load_keys`/,
    params => (params[0] as number[]).map(id => ({ chunk_id: String(id), key_rows: '1000000' })),
  ],
  [/COUNT\(DISTINCT `key_value`\) AS expected/, [{ expected: String(expected) }]],
  [/COUNT\(DISTINCT k\.`key_value`\) AS missing/, [{ missing: String(missing) }]],
  [/MIN\(k\.`chunk_id`\) AS chunk_id/, [{ key_value: '65f1c0a1b2c3d4e5f6a7b8c9', chunk_id: '1' }]],
  [/FROM `_msm_load_rejects`/, [{ reason: '_id: not an ObjectId: a string', c: '1' }]],
];

const deepRules = (distinct: number): Rule[] => [
  [/^SELECT `line_no` FROM `_msm_load_rejects` WHERE `chunk_id` = \?/, []],
  [/TEMPORARY TABLE/, []],
  [/^INSERT IGNORE INTO `_msm_ids`/, []],
  [/^SELECT COUNT\(\*\) AS c FROM `_msm_ids`$/, [{ c: String(distinct) }]],
  [/^SELECT COUNT\(\*\) AS c FROM `_msm_ids` i LEFT JOIN/, [{ c: '0' }]],
  [/NOT EXISTS/, [{ c: '0' }]],
];

async function setup(
  options: { mapping?: boolean; config?: Record<string, unknown>; signal?: AbortSignal } = {}
) {
  const dir = await tmpDir();
  const mappingsDir = join(dir, 'mappings');

  await mkdir(mappingsDir, { recursive: true });

  if (options.mapping !== false)
    await writeFile(join(mappingsDir, 'audit_log.mapping.json'), JSON.stringify(twinMappingJson));

  const config = exampleConfig(
    {
      stateDir: dir,
      mappingsDir,
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      ...(options.config ?? {}),
    },
    dir
  );

  const { ctx, store, layout, events } = memoryContext({
    command: 'reconcile',
    config,
    signal: options.signal,
  });

  const seed = seedArchive(store, layout);
  const collections: CollectionConfig[] = [{ name: 'audit_log', window: 'day', rest: 'auto' }];

  const messages = () =>
    events
      .filter(
        (e): e is Extract<MsmEvent, { type: 'info' | 'warn' }> =>
          e.type === 'info' || e.type === 'warn'
      )
      .map(e => `${e.type}: ${e.message}`);

  return { ctx, store, layout, events, seed, collections, dir, messages };
}

describe('reconcile', () => {
  it('a run that checks no table is a config error, not "no drift"', async () => {
    const { ctx, store, collections, messages } = await setup({ mapping: false });
    const { mysql, calls } = fakePool([]);

    await expect(reconcile({ ctx, store, mysql, collections })).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: expect.stringMatching(
        new RegExp(
          '^nothing reconciled: no selected collection has a mapping under ' +
            '.*mappings; run infer first, or check -C and mappingsDir$'
        )
      ),
    });

    expect(messages()).toEqual([
      expect.stringMatching(
        /^warn: audit_log: no mapping at .*audit_log\.mapping\.json; skipped \(run infer first\)$/
      ),
    ]);

    expect(calls).toEqual([]);

    // Named with -C, the same collection is fatal at once: a typo must not pass as a skip.
    await expect(
      reconcile({
        ctx,
        store,
        mysql,
        collections: [{ name: 'orderz', window: 'day', rest: 'auto' }],
        narrowed: true,
      })
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: expect.stringMatching(
        /^-C orderz: no mapping at .*orderz\.mapping\.json; run infer first, or check the name$/
      ),
    });
  });

  it('a mapped collection never seen is fatal under -C; an unmapped one only warns', async () => {
    const { ctx, store, seed, dir, messages } = await setup();

    await writeFile(
      join(dir, 'mappings', 'orderz.mapping.json'),
      JSON.stringify({ ...twinMappingJson, collection: 'orderz' })
    );

    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

    await seed.batch(batchId, 1);

    const rows = [
      ledgerRow({
        chunk_run_id: a.runId,
        manifest_sha256: await store.putText(
          'scratch',
          JSON.stringify(a.manifest),
          'application/json'
        ),
        exported_count: 3,
        lines_done: 3,
        rows_inserted: 3,
      }),
    ];

    const { mysql } = fakePool([...schemaRules, ledgerRule(rows), ...tableRules(3, 3, 0)]);

    await expect(
      reconcile({
        ctx,
        store,
        mysql,
        collections: [{ name: 'orderz', window: 'day', rest: 'auto' }],
        narrowed: true,
        batchIds: [batchId],
      })
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message:
        '-C orderz: no chunk manifest under ' +
        's3://example-archive-bucket/mongo-archive and no ledger row in ' +
        'audit_log_entries; check the name',
    });

    const mixed = await reconcile({
      ctx,
      store,
      mysql,
      collections: [
        { name: 'audit_log', window: 'day', rest: 'auto' },
        { name: 'unmapped', window: 'day', rest: 'auto' },
      ],
    });

    expect(mixed.exitCode).toBe(exitCodes.ok);
    expect(mixed.perTable).toHaveLength(1);

    expect(messages()).toContainEqual(
      expect.stringMatching(
        /^warn: unmapped: no mapping at .*unmapped\.mapping\.json; skipped \(run infer first\)$/
      )
    );
  });

  it('a configured mapping path that does not exist is fatal, as is a missing table', async () => {
    const { ctx, store, dir } = await setup();
    const { mysql } = fakePool([[/information_schema\.COLUMNS/, []]]);

    await expect(
      reconcile({
        ctx,
        store,
        mysql,
        collections: [
          { name: 'audit_log', window: 'day', rest: 'auto', mapping: join(dir, 'nope.json') },
        ],
      })
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: expect.stringContaining('configured mapping'),
    });

    await expect(
      reconcile({
        ctx,
        store,
        mysql,
        collections: [{ name: 'audit_log', window: 'day', rest: 'auto' }],
      })
    ).rejects.toMatchObject({
      msmCode: 'config',
      message: 'audit_log: table archive.audit_log_entries does not exist',
    });
  });

  it('reports no drift when ledger, manifests and key ledger agree, with info lines', async () => {
    const { ctx, store, seed, collections, messages, events } = await setup();
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

    await seed.batch(batchId, 1);

    const rows = [
      ledgerRow({
        chunk_run_id: a.runId,
        manifest_sha256: await store.putText(
          'scratch',
          JSON.stringify(a.manifest),
          'application/json'
        ),
        exported_count: 3,
        lines_done: 3,
        rows_inserted: 2,
        rows_rejected: 1,
      }),
    ];

    const { mysql } = fakePool([...schemaRules, ledgerRule(rows), ...tableRules(12, 2, 0)]);
    const result = await reconcile({ ctx, store, mysql, collections, showOk: true });

    expect(result.exitCode).toBe(exitCodes.ok);
    expect(result.drifts).toEqual([]);

    expect(result.perTable).toEqual([
      {
        table: 'audit_log_entries',
        chunks: 1,
        keyed: 12,
        untracked: 0,
        foreign: 10,
        rejected: 1,
        castErrors: 0,
        deep: false,
      },
    ]);

    expect(messages()).toEqual([
      'info: audit_log_entries: 1 lines rejected at load; reasons: _id: not an ' +
        'ObjectId: a string (1)',
      'info: audit_log_entries: 10 keyed rows are outside the selected batches ' +
        '(other batches or an earlier importer)',
      'info: no drift in 1 tables',
    ]);

    expect(events.filter(e => e.type === 'warn')).toEqual([]);

    expect(events.filter(e => e.type === 'chunk')).toEqual([
      expect.objectContaining({ chunk: a.runId, status: 'done', detail: '3 docs, ledger agrees' }),
    ]);
  });

  it('a chunk lacking key rows leaves coverage unproven: a warning, no deep_distinct', async () => {
    const { ctx, store, seed, collections, messages } = await setup();
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

    await seed.batch(batchId, 1);

    const rows = [
      ledgerRow({
        chunk_run_id: a.runId,
        manifest_sha256: await store.putText(
          'scratch',
          JSON.stringify(a.manifest),
          'application/json'
        ),
        exported_count: 3,
        lines_done: 3,
        rows_inserted: 3,
      }),
    ];

    const noKeys: Rule = [/COUNT\(\*\) AS key_rows FROM `_msm_load_keys`/, []];

    const { mysql, sqls } = fakePool([
      ...schemaRules,
      ledgerRule(rows),
      noKeys,
      ...tableRules(3, 0, 0),
      ...deepRules(3),
    ]);

    const result = await reconcile({
      ctx,
      store,
      mysql,
      collections,
      deep: true,
      confirm: async () => {},
    });

    expect(result.drifts).toEqual([]);
    expect(result.exitCode).toBe(exitCodes.ok);

    expect(messages()).toContain(
      'warn: audit_log_entries: coverage unproven for 1 chunks loaded wholly or ' +
        `partly without the key ledger (${a.runId}); run --deep`
    );

    expect(sqls().some(s => s.includes('COUNT(DISTINCT `key_value`)'))).toBe(false);
  });

  it('--deep wipes the reconcile scratch area, so a crashed run leaves no downloads', async () => {
    const { ctx, store, seed, collections, dir } = await setup();
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

    await seed.batch(batchId, 1);

    const rows = [
      ledgerRow({
        chunk_run_id: a.runId,
        manifest_sha256: await store.putText(
          'scratch',
          JSON.stringify(a.manifest),
          'application/json'
        ),
        exported_count: 3,
        lines_done: 3,
        rows_inserted: 3,
      }),
    ];

    const { mysql } = fakePool([
      ...schemaRules,
      ledgerRule(rows),
      ...tableRules(3, 3, 0),
      ...deepRules(3),
    ]);

    const stale = join(tempDirOf(ctx.config, 'reconcile'), 'some-old-chunk');

    await mkdir(stale, { recursive: true, mode: 0o700 });
    await writeFile(join(stale, 'part-000001.jsonl.gz'), 'leftover');
    await reconcile({ ctx, store, mysql, collections, deep: true, confirm: async () => undefined });
    expect(await readdir(tempDirOf(ctx.config, 'reconcile'))).toEqual([]);
    expect(await access(dir).then(() => true)).toBe(true);
  });

  it.skipIf(process.getuid === undefined)(
    '--deep releases the reconcile lock when the scratch area is refused, so the ' +
      'rerun after the fix is not locked out',
    async () => {
      const { ctx, store, seed, collections } = await setup();
      const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

      await seed.batch(batchId, 1);

      const rows = [
        ledgerRow({
          chunk_run_id: a.runId,
          manifest_sha256: await store.putText(
            'scratch',
            JSON.stringify(a.manifest),
            'application/json'
          ),
          exported_count: 3,
          lines_done: 3,
          rows_inserted: 3,
        }),
      ];

      const { mysql } = fakePool([
        ...schemaRules,
        ledgerRule(rows),
        ...tableRules(3, 3, 0),
        ...deepRules(3),
      ]);

      const ownerDir = dirname(tempDirOf(ctx.config, 'reconcile'));

      await mkdir(ownerDir, { recursive: true });
      await chmod(ownerDir, 0o755);

      await expect(
        reconcile({ ctx, store, mysql, collections, deep: true, confirm: async () => undefined })
      ).rejects.toMatchObject({
        msmCode: 'config',
        message: expect.stringMatching(/is open to group or other \(mode 755\); it must be 0700/),
      });

      await chmod(ownerDir, 0o700);

      // The lock is free again: neither "reconcile already running" nor --force-unlock is needed.
      const release = await acquireLock(ctx.config.stateDir, 'reconcile', false);

      await release();

      const result = await reconcile({
        ctx,
        store,
        mysql,
        collections,
        deep: true,
        confirm: async () => undefined,
      });

      expect(result.exitCode).toBe(exitCodes.ok);
    }
  );

  it('exit 4 on a drift, 0 when every drift kind is ignored; --batch-id narrows it', async () => {
    const { ctx, store, seed, collections, messages } = await setup();
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });
    const other = 'app-archive-delta-20261020T010000Z';
    const b = await seed.chunk({ collection: 'audit_log', batchId: other, lines: lines(2, 4) });

    await seed.batch(batchId, 1);
    await seed.batch(other, 1);

    const sha = async (m: Record<string, unknown>) =>
      store.putText('scratch', JSON.stringify(m), 'application/json');

    const rows = [
      ledgerRow({
        id: 1,
        chunk_run_id: a.runId,
        manifest_sha256: await sha(a.manifest),
        exported_count: 3,
        lines_done: 3,
        rows_inserted: 3,
      }),
      ledgerRow({
        id: 2,
        batch_id: other,
        chunk_run_id: b.runId,
        manifest_sha256: await sha(b.manifest),
        exported_count: 2,
        lines_done: 2,
        rows_inserted: 2,
      }),
    ];

    const make = () => fakePool([...schemaRules, ledgerRule(rows), ...tableRules(4, 3, 1)]);

    const drifted = await reconcile({
      ctx,
      store,
      mysql: make().mysql,
      collections,
      batchIds: [batchId],
    });

    expect(drifted.exitCode).toBe(exitCodes.drift);

    expect(drifted.drifts).toEqual([
      expect.objectContaining({ kind: 'table_count', expected: 3, actual: 2 }),
    ]);

    expect(drifted.perTable[0]).toMatchObject({ chunks: 1, foreign: 2 });
    expect(messages().at(-1)).toBe('info: 1 drifts (0 ignored) in 1 tables');

    const { mysql, calls } = make();

    const ignored = await reconcile({
      ctx,
      store,
      mysql,
      collections,
      batchIds: [batchId],
      ignore: ['table_count'],
    });

    expect(ignored.exitCode).toBe(exitCodes.ok);
    expect(ignored.drifts).toHaveLength(1);
    expect(messages().some(m => m.endsWith('(ignored)'))).toBe(true);
    // Only the selected batch's ledger row feeds the key-ledger queries.
    expect(calls.find(c => c.sql.includes('AS expected'))?.params).toEqual([[1]]);
  });

  it('with nothing loaded every archived batch is selected, every chunk not_loaded', async () => {
    const { ctx, store, seed, collections, messages } = await setup({
      config: { load: { keyLedger: false } },
    });

    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

    await seed.batch(batchId, 1, { failed_chunks: 1 });

    const { mysql, sqls } = fakePool([
      ...schemaRules,
      ledgerRule([]),
      [/AS keyed/, [{ keyed: '0', untracked: '5' }]],
    ]);

    const result = await reconcile({ ctx, store, mysql, collections });

    expect(result.drifts.map(d => [d.kind, d.chunk])).toEqual([
      ['batch_incomplete', null],
      ['not_loaded', a.runId],
    ]);

    expect(result.exitCode).toBe(exitCodes.drift);

    expect(messages()).toContain(
      'warn: audit_log_entries: table coverage unproven without the key ledger ' +
        '(load.keyLedger is false); run --deep'
    );

    expect(messages()).toContain(
      "info: audit_log_entries: 5 rows have no key (the application's own)"
    );

    expect(sqls().some(s => s.includes('_msm_load_keys'))).toBe(false);
  });

  it('--deep asks first and adds deep_distinct when parts and key ledger disagree', async () => {
    const { ctx, store, seed, collections } = await setup();
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

    await seed.batch(batchId, 1);

    const rows = [
      ledgerRow({
        chunk_run_id: a.runId,
        manifest_sha256: await store.putText(
          'scratch',
          JSON.stringify(a.manifest),
          'application/json'
        ),
        exported_count: 3,
        lines_done: 3,
        rows_inserted: 3,
      }),
    ];

    const { mysql, sqls } = fakePool([
      ...schemaRules,
      ledgerRule(rows),
      ...tableRules(3, 4, 0),
      ...deepRules(3),
    ]);

    const questions: string[] = [];

    const result = await reconcile({
      ctx,
      store,
      mysql,
      collections,
      deep: true,
      confirm: async q => {
        questions.push(q);
      },
    });

    expect(questions).toEqual([
      expect.stringMatching(/^Read \d+ B in 1 parts of 1 chunks to prove 1 tables row by row\?$/),
    ]);

    expect(result.drifts).toEqual([
      {
        table: 'audit_log_entries',
        kind: 'deep_distinct',
        chunk: null,
        expected: 4,
        actual: 3,
        detail: '3 distinct ids read from the parts, the key ledger holds 4',
      },
    ]);

    expect(result.exitCode).toBe(exitCodes.drift);
    expect(result.perTable[0]).toMatchObject({ deep: true, foreign: 0 });
    expect(sqls().some(s => s.includes('NOT EXISTS'))).toBe(true);

    const declined = fakePool([...schemaRules, ledgerRule(rows), ...tableRules(3, 3, 0)]);

    await expect(
      reconcile({
        ctx,
        store,
        mysql: declined.mysql,
        collections,
        deep: true,
        confirm: async () => {
          throw new Error('aborted');
        },
      })
    ).rejects.toThrow('aborted');
  });

  it('two collections on one table match their own ledger rows; table proven once', async () => {
    const { ctx, store, seed, dir, messages } = await setup();

    await writeFile(
      join(dir, 'mappings', 'audit_log_old.mapping.json'),
      JSON.stringify({ ...twinMappingJson, collection: 'audit_log_old' })
    );

    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

    const b = await seed.chunk({
      collection: 'audit_log_old',
      batchId,
      mode: 'full-collection',
      lines: lines(2, 10),
    });

    await seed.batch(batchId, 2);

    const sha = async (m: Record<string, unknown>) =>
      store.putText('scratch', JSON.stringify(m), 'application/json');

    const rows = [
      ledgerRow({
        id: 1,
        chunk_run_id: a.runId,
        manifest_sha256: await sha(a.manifest),
        exported_count: 3,
        lines_done: 3,
        rows_inserted: 3,
      }),
      ledgerRow({
        id: 2,
        collection: 'audit_log_old',
        chunk_run_id: b.runId,
        manifest_sha256: await sha(b.manifest),
        exported_count: 2,
        lines_done: 2,
        rows_inserted: 2,
      }),
    ];

    const { mysql, calls } = fakePool([...schemaRules, ledgerRule(rows), ...tableRules(5, 5, 0)]);

    const collections: CollectionConfig[] = [
      { name: 'audit_log', window: 'day', rest: 'auto' },
      { name: 'audit_log_old', window: 'day', rest: 'auto' },
    ];

    const result = await reconcile({ ctx, store, mysql, collections });

    expect(result.drifts).toEqual([]);
    expect(result.exitCode).toBe(exitCodes.ok);

    expect(result.perTable).toEqual([
      {
        table: 'audit_log_entries',
        chunks: 2,
        keyed: 5,
        untracked: 0,
        foreign: 0,
        rejected: 0,
        castErrors: 0,
        deep: false,
      },
    ]);

    expect(calls.filter(c => c.sql.includes('AS keyed'))).toHaveLength(1);
    expect(calls.find(c => c.sql.includes('AS expected'))?.params).toEqual([[1, 2]]);
    expect(messages().at(-1)).toBe('info: no drift in 1 tables');
  });

  it('-C on one of two table-sharing collections: --deep skips the whole-table check', async () => {
    const { ctx, store, seed, dir, messages } = await setup();

    await writeFile(
      join(dir, 'mappings', 'audit_log_old.mapping.json'),
      JSON.stringify({ ...twinMappingJson, collection: 'audit_log_old' })
    );

    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

    const b = await seed.chunk({
      collection: 'audit_log_old',
      batchId,
      mode: 'full-collection',
      lines: lines(2, 10),
    });

    await seed.batch(batchId, 2);

    const sha = async (m: Record<string, unknown>) =>
      store.putText('scratch', JSON.stringify(m), 'application/json');

    const rows = [
      ledgerRow({
        id: 1,
        chunk_run_id: a.runId,
        manifest_sha256: await sha(a.manifest),
        exported_count: 3,
        lines_done: 3,
        rows_inserted: 3,
      }),
      ledgerRow({
        id: 2,
        collection: 'audit_log_old',
        chunk_run_id: b.runId,
        manifest_sha256: await sha(b.manifest),
        exported_count: 2,
        lines_done: 2,
        rows_inserted: 2,
      }),
    ];

    // The table holds both collections' rows (5 keyed); the NOT EXISTS stub would report the other
    // collection's 2 rows as unknown if it ran.
    const { mysql, sqls } = fakePool([
      ...schemaRules,
      ledgerRule(rows),
      ...tableRules(5, 3, 0),
      ...deepRules(3).filter(([re]) => !re.test('NOT EXISTS')),
      [/NOT EXISTS/, [{ c: '2' }]],
    ]);

    const collections: CollectionConfig[] = [{ name: 'audit_log', window: 'day', rest: 'auto' }];

    const result = await reconcile({
      ctx,
      store,
      mysql,
      collections,
      deep: true,
      confirm: async () => undefined,
    });

    expect(result.drifts).toEqual([]);
    expect(result.exitCode).toBe(exitCodes.ok);

    expect(result.perTable).toEqual([
      {
        table: 'audit_log_entries',
        chunks: 1,
        keyed: 5,
        untracked: 0,
        foreign: 2,
        rejected: 0,
        castErrors: 0,
        deep: true,
      },
    ]);

    expect(sqls().some(s => s.includes('NOT EXISTS'))).toBe(false);

    expect(messages()).toContain(
      'warn: audit_log_entries: also loaded from audit_log_old, not selected in ' +
        'this run; their rows count as foreign and the whole-table deep check is ' +
        'skipped'
    );
  });

  it('a --batch-id that no manifest and no ledger row knows is a config error', async () => {
    const { ctx, store, seed, collections } = await setup();
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

    await seed.batch(batchId, 1);

    const rows = [
      ledgerRow({ chunk_run_id: a.runId, exported_count: 3, lines_done: 3, rows_inserted: 3 }),
    ];

    const { mysql } = fakePool([...schemaRules, ledgerRule(rows)]);

    await expect(
      reconcile({ ctx, store, mysql, collections, batchIds: ['typo-batch'] })
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: expect.stringContaining(
        'batch typo-batch not found under s3://example-archive-bucket/mongo-archive'
      ),
    });
  });

  it('--deep takes the reconcile lock; an interrupt returns the signal exit code', async () => {
    const controller = new AbortController();
    const { ctx, store, seed, collections, dir } = await setup({ signal: controller.signal });
    const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

    await seed.batch(batchId, 1);

    const rows = [
      ledgerRow({
        chunk_run_id: a.runId,
        manifest_sha256: await store.putText(
          'scratch',
          JSON.stringify(a.manifest),
          'application/json'
        ),
        exported_count: 3,
        lines_done: 3,
        rows_inserted: 3,
      }),
    ];

    const { mysql } = fakePool([
      ...schemaRules,
      ledgerRule(rows),
      ...tableRules(3, 3, 0),
      ...deepRules(3),
    ]);

    const held = await acquireLock(dir, 'reconcile', false);

    await expect(reconcile({ ctx, store, mysql, collections, deep: true })).rejects.toMatchObject({
      msmCode: 'lock',
      message: expect.stringContaining('reconcile already running'),
    });

    await held();

    const result = await reconcile({
      ctx,
      store,
      mysql,
      collections,
      deep: true,
      confirm: async () => {
        controller.abort('SIGINT');
      },
    });

    expect(result.exitCode).toBe(exitCodes.sigint);
    expect(result.perTable).toHaveLength(1);

    await (
      await acquireLock(dir, 'reconcile', false)
    )();
  });

  it('an aborted run returns the signal exit code without touching MySQL', async () => {
    const controller = new AbortController();
    const { ctx, store, collections } = await setup({ signal: controller.signal });

    controller.abort('SIGTERM');

    const { mysql, calls } = fakePool([]);
    const result = await reconcile({ ctx, store, mysql, collections });

    expect(result.exitCode).toBe(exitCodes.sigterm);
    expect(calls).toEqual([]);
  });
});
