import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import exitCodes from '#cli/exitCodes';
import load from '#load/load';
import loadMapping from '#mapping/loadMapping';
import replayPendingSha from '#mysql/replayPendingSha';
import acquireLock from '#runtime/acquireLock';
import type { CollectionConfig, LedgerRow, MsmEvent } from '#types';
import { exampleConfig, memoryContext, tmpDir } from '../../helpers.js';
import { fakeMysql, header, tupleCount } from '../mysql/fakeMysql.js';
import type { Rule } from '../mysql/fakeMysql.js';
import seedArchive, { docLine, lines, sha256 } from '../verify/seedArchive.js';
import type { SeededChunk } from '../verify/seedArchive.js';
import { batchId, ledgerRow, simpleMappingJson, simpleSchemaRows } from './fixtures.js';

const olderBatch = 'app-archive-full-20261001T020304Z';
const newerBatch = 'app-archive-delta-20261020T010000Z';

/**
 * A ledger that remembers what the run wrote: rows are registered on INSERT IGNORE, marked loaded
 * with the counters the batch UPDATEs added, and read back by readLedger before and after the run.
 */
function ledgerFake(initial: LedgerRow[] = []) {
  const rows: LedgerRow[] = [...initial];
  let nextId = rows.reduce((max, r) => Math.max(max, r.id), 0) + 1;

  const stringy = (r: LedgerRow) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])
    );

  const byId = (id: unknown) => rows.find(r => r.id === Number(id));

  const rules: Rule[] = [
    [
      /^SELECT \* FROM `_msm_load_chunks` WHERE `target_table` = \? ORDER BY `id`$/,
      params => rows.filter(r => r.target_table === params[0]).map(stringy),
    ],
    [
      /^INSERT IGNORE INTO `_msm_load_chunks`/,
      params => {
        const [
          target_table,
          collection,
          batch_id,
          chunk_run_id,
          batch_cutoff_utc,
          manifest_key,
          manifest_sha256,
          mapping_sha256,
          exported_count,
          load_run_id,
        ] = params as string[];

        if (rows.some(r => r.target_table === target_table && r.chunk_run_id === chunk_run_id))
          return header(0);

        rows.push(
          ledgerRow({
            id: nextId++,
            target_table: target_table as string,
            collection: collection as string,
            batch_id: batch_id as string,
            chunk_run_id: chunk_run_id as string,
            batch_cutoff_utc: batch_cutoff_utc as string | null,
            manifest_key: manifest_key as string,
            manifest_sha256: manifest_sha256 as string,
            mapping_sha256: mapping_sha256 as string,
            exported_count: Number(exported_count),
            load_run_id: load_run_id as string,
            status: 'loading',
            lines_done: 0,
            rows_inserted: 0,
            attempts: 0,
            finished_at: null,
          })
        );

        return header(1);
      },
    ],
    [
      new RegExp(
        '^SELECT `id`, `status`, `lines_done`, `manifest_sha256`, `mapping_sha256` ' +
          'FROM `_msm_load_chunks`'
      ),
      params => {
        const r = rows.find(x => x.target_table === params[0] && x.chunk_run_id === params[1]);

        return r
          ? [
              {
                id: String(r.id),
                status: r.status,
                lines_done: String(r.lines_done),
                manifest_sha256: r.manifest_sha256,
                mapping_sha256: r.mapping_sha256,
              },
            ]
          : [];
      },
    ],
    [
      /^UPDATE `_msm_load_chunks` SET `lines_done` = 0, `rows_inserted` = 0/,
      params => {
        const r = byId(params[2]);

        if (r)
          Object.assign(r, {
            lines_done: 0,
            rows_inserted: 0,
            rows_updated: 0,
            duplicates_skipped: 0,
            rows_rejected: 0,
            cast_errors: 0,
            status: 'loading',
            manifest_sha256: params[0],
            mapping_sha256: params[1],
          });

        return header(1);
      },
    ],
    [/^DELETE FROM `_msm_load_(rejects|keys)`/, header(0)],
    [
      /^UPDATE `_msm_load_chunks` SET `status` = 'loading', `attempts`/,
      params => {
        const r = byId(params[6]);

        if (r)
          Object.assign(r, {
            status: 'loading',
            attempts: r.attempts + 1,
            load_run_id: params[0],
            manifest_sha256: params[1],
            mapping_sha256: params[2],
            exported_count: Number(params[3]),
            manifest_key: params[4],
            batch_cutoff_utc: params[5] ?? r.batch_cutoff_utc,
          });

        return header(1);
      },
    ],
    [
      /^UPDATE `_msm_load_chunks` SET `lines_done` = \?/,
      params => {
        const [lines_done, inserted, updated, duplicates, rejected, castErrors, id] =
          params as number[];

        const r = byId(id);

        if (r)
          Object.assign(r, {
            lines_done,
            rows_inserted: r.rows_inserted + (inserted as number),
            rows_updated: r.rows_updated + (updated as number),
            duplicates_skipped: r.duplicates_skipped + (duplicates as number),
            rows_rejected: r.rows_rejected + (rejected as number),
            cast_errors: r.cast_errors + (castErrors as number),
          });

        return header(1);
      },
    ],
    [
      /^UPDATE `_msm_load_chunks` SET `status` = 'loaded'/,
      params => {
        const r = byId(params[0]);

        if (r) Object.assign(r, { status: 'loaded', finished_at: '2026-10-13 04:05:00.000' });

        return header(1);
      },
    ],
    [
      /^UPDATE `_msm_load_chunks` SET `status` = 'loading', `manifest_sha256` = \?, `updated_at`/,
      params => {
        const r = rows.find(x => x.target_table === params[1] && x.chunk_run_id === params[2]);

        if (r) Object.assign(r, { status: 'loading', manifest_sha256: params[0] });

        return header(r ? 1 : 0);
      },
    ],
    [
      /^UPDATE `_msm_load_chunks` SET `status` = 'failed', `error` = \?/,
      params => {
        const r = rows.find(x => x.target_table === params[1] && x.chunk_run_id === params[2]);

        if (r) Object.assign(r, { status: 'failed', error: params[0] });

        return header(1);
      },
    ],
  ];

  return { rows, rules };
}

const schemaRules = (present = true): Rule[] => [
  [
    /FROM information_schema\.COLUMNS/,
    params => (present && params[1] === 'audit_log_entries' ? simpleSchemaRows.columns : []),
  ],
  [/FROM information_schema\.STATISTICS/, simpleSchemaRows.indexes],
];

const dataRules = (lockGot = 1): Rule[] => [
  [/^CREATE TABLE IF NOT EXISTS/, header(0)],
  [/^SELECT GET_LOCK\(\?, 0\) AS got$/, [{ got: lockGot }]],
  [/^SET SESSION wait_timeout = 31536000$/, header(0)],
  [/^SELECT 1$/, [{ 1: 1 }]],
  [/^SELECT RELEASE_LOCK\(\?\)$/, [{ released: 1 }]],
  [/^SELECT IS_USED_LOCK\(\?\) = CONNECTION_ID\(\) AS held$/, [{ held: 1 }]],
  [/^START TRANSACTION$/, header(0)],
  [/FOR UPDATE$/, []],
  [
    /^INSERT INTO `audit_log_entries` /,
    (_p, sql) => header(tupleCount(sql), `Records: ${tupleCount(sql)}  Duplicates: 0  Warnings: 0`),
  ],
  [/^INSERT IGNORE INTO `_msm_load_(rejects|keys)`/, header(0)],
  [/^COMMIT$/, header(0)],
  [/^ROLLBACK$/, header(0)],
];

async function setup(
  options: {
    mapping?: boolean;
    config?: Record<string, unknown>;
    signal?: AbortSignal;
    ledger?: LedgerRow[];
    rules?: Rule[];
    lockGot?: number;
    packet?: number;
  } = {}
) {
  const dir = await tmpDir();
  const mappingsDir = join(dir, 'mappings');

  await mkdir(mappingsDir, { recursive: true });

  if (options.mapping !== false)
    await writeFile(join(mappingsDir, 'audit_log.mapping.json'), JSON.stringify(simpleMappingJson));

  const config = exampleConfig(
    {
      stateDir: dir,
      mappingsDir,
      minFreeDiskMb: 0,
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      load: { concurrency: 2 },
      ...(options.config ?? {}),
    },
    dir
  );

  const mc = memoryContext({ command: 'load', config, signal: options.signal });
  const seed = seedArchive(mc.store, mc.layout);
  const ledger = ledgerFake(options.ledger);

  const fake = fakeMysql(
    [...(options.rules ?? []), ...schemaRules(), ...ledger.rules, ...dataRules(options.lockGot)],
    { maxAllowedPacket: options.packet }
  );

  const collections: CollectionConfig[] = [{ name: 'audit_log', window: 'day', rest: 'auto' }];

  /** A chunk plus the parse-check that verifies it against the exact manifest body written. */
  const verifiedChunk = async (
    spec: Partial<Parameters<typeof seed.chunk>[0]> & { batchId: string },
    ok = true
  ): Promise<SeededChunk> => {
    const chunk = await seed.chunk({ collection: 'audit_log', lines: lines(3), ...spec });
    const manifestSha = sha256(JSON.stringify(chunk.manifest));

    await mc.store.putText(
      mc.layout.parseCheck('audit_log', chunk.runId),
      JSON.stringify({
        run_id: chunk.runId,
        collection: 'audit_log',
        mode: chunk.manifest.mode,
        gzip_test: true,
        first_line_parseable: true,
        first_line_has_id: true,
        manifest_only: false,
        ok,
        manifest_sha256: manifestSha,
      }),
      'application/json'
    );

    return chunk;
  };

  const asked: string[] = [];

  const confirm = async (q: string) => {
    asked.push(q);
  };

  const messages = () =>
    mc.events
      .filter(
        (e): e is Extract<MsmEvent, { type: 'info' | 'warn' }> =>
          e.type === 'info' || e.type === 'warn'
      )
      .map(e => `${e.type}: ${e.message}`);

  const chunkEvents = () =>
    mc.events
      .filter((e): e is Extract<MsmEvent, { type: 'chunk' }> => e.type === 'chunk')
      .map(e => `${e.chunk} ${e.status}${e.detail ? `: ${e.detail}` : ''}`);

  return {
    ...mc,
    ...fake,
    seed,
    ledger,
    collections,
    dir,
    verifiedChunk,
    asked,
    confirm,
    messages,
    chunkEvents,
  };
}

describe('load', () => {
  it('needs the mysql config section', async () => {
    const { ctx, store, mysql, collections } = await setup();
    const noMysql = { ...ctx, config: { ...ctx.config, mysql: undefined } };

    await expect(load({ ctx: noMysql, store, mysql, collections })).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
    });
  });

  it('skips a collection without a mapping file with a warning and loads nothing', async () => {
    const { ctx, store, mysql, collections, messages, calls } = await setup({ mapping: false });
    const result = await load({ ctx, store, mysql, collections });

    expect(result).toMatchObject({ outcomes: [], perTable: [], exitCode: exitCodes.ok });
    expect(result.loadRunId).toMatch(/^load-\d{8}T\d{6}Z$/);

    expect(messages()).toEqual([
      expect.stringMatching(
        /^warn: audit_log: no mapping at .*audit_log\.mapping\.json; skipped \(run infer first\)$/
      ),
      'info: nothing to load: 0 chunks skipped',
    ]);

    expect(calls).toEqual([]);
  });

  it('a nonexistent mapping path is fatal, like shape errors without --create-tables', async () => {
    const { ctx, store, mysql, dir } = await setup();

    await expect(
      load({
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
      message: expect.stringContaining('nope.json does not exist'),
    });

    const missing = await setup({ rules: [[/FROM information_schema\.COLUMNS/, []]] });

    await expect(
      load({
        ctx: missing.ctx,
        store: missing.store,
        mysql: missing.mysql,
        collections: missing.collections,
      })
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: expect.stringContaining('missing table audit_log_entries'),
    });
  });

  it('a dry run lists candidates and skips per batch, prints the DDL, writes nothing', async () => {
    const t = await setup({ rules: [[/FROM information_schema\.COLUMNS/, []]] });
    const a = await t.verifiedChunk({ batchId });

    const b = await t.seed.chunk({
      collection: 'audit_log',
      batchId,
      mode: 'full-collection',
      tail: 'rest',
      lines: lines(2),
    });

    await t.seed.batch(batchId, 2);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      dryRun: true,
      createTables: true,
      confirm: t.confirm,
    });

    expect(result.exitCode).toBe(exitCodes.ok);

    expect(result.outcomes).toEqual([
      { chunk: b.runId, collection: 'audit_log', status: 'skipped', note: 'unverified' },
    ]);

    expect(result.perTable).toEqual([
      {
        table: 'audit_log_entries',
        chunks: 1,
        inserted: 0,
        updated: 0,
        duplicates: 0,
        rejected: 0,
      },
    ]);

    expect(t.messages()).toEqual([
      `info: load    ${a.runId}`,
      `info: skip    ${b.runId}: unverified`,
      `info: batch ${batchId}: 1 chunks to load, 1 skipped`,
      'info: would run: CREATE TABLE IF NOT EXISTS `audit_log_entries` ( ...',
      'info: dry run: ~3 documents from 1 chunks into audit_log_entries; nothing written',
    ]);

    expect(t.asked).toEqual([]);

    expect(
      t
        .sqls()
        .filter(
          s =>
            !s.includes('information_schema') && !s.startsWith('SELECT * FROM `_msm_load_chunks`')
        )
    ).toEqual([]);
  });

  it('skips needing attention end with exit 2 and a chunk event, no prompt or ledger', async () => {
    const t = await setup();
    const a = await t.verifiedChunk({ batchId }, false);

    await t.seed.batch(batchId, 1);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(result.exitCode).toBe(exitCodes.incomplete);

    expect(result.outcomes).toEqual([
      { chunk: a.runId, collection: 'audit_log', status: 'skipped', note: 'unverified' },
    ]);

    expect(t.chunkEvents()).toEqual([`${a.runId} skipped: unverified`]);
    expect(t.asked).toEqual([]);
    expect(t.sqls().some(s => s.startsWith('CREATE TABLE'))).toBe(false);

    expect(result.perTable).toEqual([
      {
        table: 'audit_log_entries',
        chunks: 0,
        inserted: 0,
        updated: 0,
        duplicates: 0,
        rejected: 0,
      },
    ]);
  });

  it('loads: confirms, creates the ledger, locks each table, loads chunks, releases', async () => {
    const t = await setup();
    const a = await t.verifiedChunk({ batchId });

    const b = await t.verifiedChunk({
      batchId,
      mode: 'full-collection',
      tail: 'rest',
      lines: lines(2, 10),
    });

    await t.seed.batch(batchId, 2);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      loadRunId: 'load-test',
      confirm: t.confirm,
    });

    expect(t.asked).toEqual([
      'Upsert ~5 documents from 2 chunks into archive.audit_log_entries on mysql.example.internal?',
    ]);

    expect(result.exitCode).toBe(exitCodes.ok);
    expect(result.loadRunId).toBe('load-test');

    expect(result.outcomes.map(o => [o.chunk, o.status, o.docs]).sort()).toEqual(
      [
        [a.runId, 'done', 3],
        [b.runId, 'done', 2],
      ].sort()
    );

    expect(result.perTable).toEqual([
      {
        table: 'audit_log_entries',
        chunks: 2,
        inserted: 5,
        updated: 0,
        duplicates: 0,
        rejected: 0,
      },
    ]);

    expect(
      t
        .sqls('pool')
        .filter(s => s.startsWith('CREATE TABLE'))
        .map(s => /`(_msm_\w+)`/.exec(s)?.[1])
    ).toEqual(['_msm_load_chunks', '_msm_load_rejects', '_msm_load_keys']);

    expect(t.sqls('lock')).toEqual([
      'SELECT GET_LOCK(?, 0) AS got',
      'SET SESSION wait_timeout = 31536000',
      'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held',
      'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held',
      'SELECT RELEASE_LOCK(?)',
    ]);

    const lockName = t.calls.find(c => c.sql.startsWith('SELECT GET_LOCK'))?.params[0] as string;

    expect(lockName).toMatch(/^msm:[0-9a-f]{40}$/);
    expect(t.calls.find(c => c.sql.startsWith('SELECT RELEASE_LOCK'))?.params).toEqual([lockName]);
    expect(t.counts).toMatchObject({ connected: 1, ended: 1 });

    expect(
      t.ledger.rows.map(r => [r.chunk_run_id, r.status, r.lines_done, r.load_run_id]).sort()
    ).toEqual(
      [
        [a.runId, 'loaded', 3, 'load-test'],
        [b.runId, 'loaded', 2, 'load-test'],
      ].sort()
    );

    expect(t.messages().at(-1)).toBe(
      'info: load load-test: 2 of 2 chunks loaded, 5 documents this run, 0 skipped'
    );

    expect(t.events.filter(e => e.type === 'progress')).toHaveLength(2);

    // The state lock is released: another load can take it.
    await (
      await acquireLock(t.dir, 'load', false)
    )();
  });

  it('without the key ledger only two ledger tables are created', async () => {
    const t = await setup({ config: { load: { keyLedger: false } } });

    await t.verifiedChunk({ batchId });
    await t.seed.batch(batchId, 1);

    await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(t.sqls().filter(s => s.startsWith('CREATE TABLE'))).toHaveLength(2);
    expect(t.sqls().some(s => s.includes('_msm_load_keys'))).toBe(false);
  });

  it('--create-tables runs the queued DDL after the prompt, re-reads the new table', async () => {
    let created = false;

    const rules: Rule[] = [
      [/FROM information_schema\.COLUMNS/, () => (created ? simpleSchemaRows.columns : [])],
      [
        /^CREATE TABLE IF NOT EXISTS `audit_log_entries`/,
        () => {
          created = true;

          return header(0);
        },
      ],
    ];

    const t = await setup({ rules });

    await t.verifiedChunk({ batchId });
    await t.seed.batch(batchId, 1);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      createTables: true,
      confirm: t.confirm,
    });

    expect(t.asked).toEqual([
      'Upsert ~3 documents from 1 chunks into archive.audit_log_entries on ' +
        'mysql.example.internal? 1 CREATE TABLE runs first.',
    ]);

    expect(result.exitCode).toBe(exitCodes.ok);

    const s = t.sqls('pool');

    expect(
      s.indexOf(
        s.find(x => x.startsWith('CREATE TABLE IF NOT EXISTS `audit_log_entries`')) as string
      )
    ).toBeGreaterThan(
      s.indexOf(s.find(x => x.startsWith('CREATE TABLE IF NOT EXISTS `_msm_load_keys`')) as string)
    );

    // The target table twice (shape check, recheck after CREATE) plus the three ledger tables,
    // which are created only when absent.
    expect(s.filter(x => x.includes('information_schema.COLUMNS'))).toHaveLength(5);
  });

  it('a GET_LOCK another loader holds is fatal and closes the dedicated connection', async () => {
    const t = await setup({ lockGot: 0 });

    await t.verifiedChunk({ batchId });
    await t.seed.batch(batchId, 1);

    await expect(
      load({
        ctx: t.ctx,
        store: t.store,
        mysql: t.mysql,
        collections: t.collections,
        confirm: t.confirm,
      })
    ).rejects.toMatchObject({
      msmCode: 'lock',
      fatal: true,
      message: 'another loader holds the lock on archive.audit_log_entries; wait for it to finish',
    });

    expect(t.counts).toMatchObject({ connected: 1, ended: 1 });
    expect(t.sqls().some(s => s.startsWith('INSERT IGNORE INTO `_msm_load_chunks`'))).toBe(false);

    await (
      await acquireLock(t.dir, 'load', false)
    )();
  });

  it('batches load oldest cutoff first and an already loaded chunk is a quiet skip', async () => {
    const t = await setup();
    const old = await t.verifiedChunk({ batchId: olderBatch });
    const recent = await t.verifiedChunk({ batchId: newerBatch, lines: lines(2, 10) });

    await t.seed.batch(newerBatch, 1, { cutoff_utc: '2026-10-20T00:00:00Z' });
    await t.seed.batch(olderBatch, 1, { cutoff_utc: '2026-10-01T00:00:00Z' });

    const first = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(first.exitCode).toBe(exitCodes.ok);

    expect(t.messages().filter(m => m.includes('loading'))).toEqual([
      `info: batch ${olderBatch}: loading 1 chunks`,
      `info: batch ${newerBatch}: loading 1 chunks`,
    ]);

    const registered = t.calls
      .filter(c => c.sql.startsWith('INSERT IGNORE INTO `_msm_load_chunks`'))
      .map(c => c.params[3]);

    expect(registered).toEqual([old.runId, recent.runId]);
    t.events.length = 0;

    const again = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(again.exitCode).toBe(exitCodes.ok);
    expect(again.outcomes.map(o => o.note)).toEqual(['already loaded', 'already loaded']);
    expect(t.chunkEvents()).toEqual([]);
    expect(t.messages()).toContain('info: nothing to load: 2 chunks skipped');
  });

  it('the order guard refuses an older batch after a newer one unless --allow-older', async () => {
    const t = await setup({
      ledger: [
        ledgerRow({
          batch_id: newerBatch,
          chunk_run_id: `${newerBatch}-audit_log-full-collection-full`,
          batch_cutoff_utc: '2026-10-20T00:00:00Z',
        }),
      ],
    });

    await t.verifiedChunk({ batchId: olderBatch });
    await t.seed.batch(olderBatch, 1, { cutoff_utc: '2026-10-01T00:00:00Z' });

    const options = {
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    };

    await expect(load({ ...options, batchIds: [olderBatch] })).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message:
        `batch ${olderBatch} is older than loaded ${newerBatch} (audit_log_entries: ` +
        `${newerBatch}-audit_log-full-collection-full); include ${newerBatch} with ` +
        '--reload or pass --allow-older',
    });

    expect(t.asked).toEqual([]);

    const allowed = await load({ ...options, batchIds: [olderBatch], allowOlder: true });

    expect(allowed.exitCode).toBe(exitCodes.ok);

    expect(t.messages()).toContain(
      `warn: batch ${olderBatch} is older than loaded ${newerBatch}; loading it ` +
        'anyway (--allow-older)'
    );
  });

  it('the order guard passes when the newer batch is reloaded in the same run', async () => {
    const t = await setup({
      ledger: [
        ledgerRow({
          batch_id: newerBatch,
          chunk_run_id: `${newerBatch}-audit_log-full-collection-full`,
          batch_cutoff_utc: '2026-10-20T00:00:00Z',
        }),
      ],
    });

    await t.verifiedChunk({ batchId: olderBatch });

    const recent = await t.verifiedChunk({
      batchId: newerBatch,
      mode: 'full-collection',
      lines: lines(1),
    });

    await t.seed.batch(olderBatch, 1, { cutoff_utc: '2026-10-01T00:00:00Z' });
    await t.seed.batch(newerBatch, 1, { cutoff_utc: '2026-10-20T00:00:00Z' });

    // The seeded manifest sha differs from the ledger's, so without --reload the newer chunk is
    // skipped and the guard still bites.
    await expect(
      load({
        ctx: t.ctx,
        store: t.store,
        mysql: t.mysql,
        collections: t.collections,
        confirm: t.confirm,
      })
    ).rejects.toMatchObject({ msmCode: 'config' });

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
      reload: true,
    });

    expect(result.exitCode).toBe(exitCodes.ok);
    expect(result.outcomes.filter(o => o.status === 'done')).toHaveLength(2);

    expect(t.ledger.rows.find(r => r.chunk_run_id === recent.runId)).toMatchObject({
      status: 'loaded',
      lines_done: 1,
    });
  });

  it('the order guard forces a partly loaded newer chunk to replay from line 0', async () => {
    const t = await setup();
    const old = await t.verifiedChunk({ batchId: olderBatch });

    const recent = await t.verifiedChunk({
      batchId: newerBatch,
      mode: 'full-collection',
      lines: lines(4, 10),
    });

    await t.seed.batch(olderBatch, 1, { cutoff_utc: '2026-10-01T00:00:00Z' });
    await t.seed.batch(newerBatch, 1, { cutoff_utc: '2026-10-20T00:00:00Z' });

    // The newer chunk was interrupted at line 2 with the current manifest and mapping, so alone it
    // would resume at 2.
    const mappingSha256 = (await loadMapping(join(t.dir, 'mappings', 'audit_log.mapping.json')))
      .sha256;

    t.ledger.rows.push(
      ledgerRow({
        id: 9,
        batch_id: newerBatch,
        chunk_run_id: recent.runId,
        batch_cutoff_utc: '2026-10-20T00:00:00Z',
        status: 'loading',
        lines_done: 2,
        rows_inserted: 2,
        manifest_sha256: sha256(JSON.stringify(recent.manifest)),
        mapping_sha256: mappingSha256,
        exported_count: 4,
      })
    );

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(result.exitCode).toBe(exitCodes.ok);

    expect(result.outcomes.map(o => [o.chunk, o.status, o.docs]).sort()).toEqual(
      [
        [old.runId, 'done', 3],
        [recent.runId, 'done', 4],
      ].sort()
    );

    const resets = t.calls
      .filter(c => c.sql.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = 0'))
      .map(c => c.params[2]);

    expect(resets).toContain(9);

    expect(t.ledger.rows.find(r => r.id === 9)).toMatchObject({
      status: 'loaded',
      lines_done: 4,
      rows_inserted: 4,
    });
  });

  it("an empty collection list discovers the archive's collections, as verify does", async () => {
    const t = await setup();
    const a = await t.verifiedChunk({ batchId });

    await t.seed.batch(batchId, 1);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: [],
      confirm: t.confirm,
    });

    expect(result.exitCode).toBe(exitCodes.ok);
    expect(result.outcomes.map(o => [o.chunk, o.status])).toEqual([[a.runId, 'done']]);
  });

  it('an interrupt before any chunk returns the signal exit code, MySQL untouched', async () => {
    const controller = new AbortController();
    const t = await setup({ signal: controller.signal });

    await t.verifiedChunk({ batchId });
    await t.seed.batch(batchId, 1);
    controller.abort('SIGINT');

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(result).toMatchObject({ exitCode: exitCodes.sigint, outcomes: [], perTable: [] });

    expect(
      t.sqls().some(s => s.startsWith('CREATE TABLE') || s.startsWith('SELECT GET_LOCK'))
    ).toBe(false);
  });

  it('a signal during the ledger DDL returns 143 for SIGTERM and takes no table lock', async () => {
    const controller = new AbortController();

    const t = await setup({
      signal: controller.signal,
      rules: [
        [
          /^CREATE TABLE IF NOT EXISTS `_msm_load_chunks`/,
          () => {
            controller.abort('SIGTERM');

            return header(0);
          },
        ],
      ],
    });

    await t.verifiedChunk({ batchId });
    await t.seed.batch(batchId, 1);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      loadRunId: 'load-ddl',
      confirm: t.confirm,
    });

    expect(result).toMatchObject({ exitCode: exitCodes.sigterm, outcomes: [], perTable: [] });
    expect(t.sqls().some(s => s.startsWith('SELECT GET_LOCK'))).toBe(false);

    expect(t.messages()).toContain(
      'warn: load load-ddl interrupted before any chunk ran; no rows were loaded'
    );

    await (
      await acquireLock(t.dir, 'load', false)
    )();
  });

  it('a signal during the table locks or ledger re-read exits 130 and releases them', async () => {
    const controller = new AbortController();

    const t = await setup({
      signal: controller.signal,
      rules: [
        [
          /^SELECT GET_LOCK\(\?, 0\) AS got$/,
          () => {
            controller.abort('SIGINT');

            return [{ got: 1 }];
          },
        ],
      ],
    });

    await t.verifiedChunk({ batchId });
    await t.seed.batch(batchId, 1);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      loadRunId: 'load-lock',
      confirm: t.confirm,
    });

    expect(result).toMatchObject({ exitCode: exitCodes.sigint, outcomes: [], perTable: [] });
    expect(t.sqls().some(s => s.startsWith('INSERT INTO `audit_log_entries`'))).toBe(false);
    expect(t.sqls('lock').at(-1)).toBe('SELECT RELEASE_LOCK(?)');

    expect(t.messages()).toContain(
      'warn: load load-lock interrupted before any chunk ran; no rows were loaded'
    );

    await (
      await acquireLock(t.dir, 'load', false)
    )();
  });

  it('a signal during a DDL retry backoff comes out the same way', async () => {
    const controller = new AbortController();

    const deadlock = Object.assign(new Error('Lock wait timeout exceeded'), {
      errno: 1205,
      sqlState: 'HY000',
    });

    const t = await setup({
      signal: controller.signal,
      rules: [
        [
          /^CREATE TABLE IF NOT EXISTS `_msm_load_rejects`/,
          () => {
            controller.abort('SIGINT');

            throw deadlock;
          },
        ],
      ],
    });

    await t.verifiedChunk({ batchId });
    await t.seed.batch(batchId, 1);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(result).toMatchObject({ exitCode: exitCodes.sigint, outcomes: [], perTable: [] });
    expect(t.sqls().some(s => s.startsWith('SELECT GET_LOCK'))).toBe(false);
  });

  it('a row over batchMaxBytesMb but within 90% of max_allowed_packet loads alone', async () => {
    // The batch budget is 1 MiB; the packet allows about 3.6 MiB per row, so a 1.5 MiB extra-column
    // payload is a row, not a reject.
    const extraColumn = {
      COLUMN_NAME: 'extra',
      DATA_TYPE: 'json',
      COLUMN_TYPE: 'json',
      IS_NULLABLE: 'YES',
      COLUMN_DEFAULT: null,
      EXTRA: '',
      COLLATION_NAME: null,
      CHARACTER_MAXIMUM_LENGTH: null,
      CHARACTER_OCTET_LENGTH: null,
      NUMERIC_PRECISION: null,
      NUMERIC_SCALE: null,
      DATETIME_PRECISION: null,
    };

    const t = await setup({
      config: { load: { batchMaxBytesMb: 1 } },
      packet: 4 * 1024 * 1024,
      rules: [
        [
          /FROM information_schema\.COLUMNS/,
          params =>
            params[1] === 'audit_log_entries' ? [...simpleSchemaRows.columns, extraColumn] : [],
        ],
      ],
    });

    await writeFile(
      join(t.dir, 'mappings', 'audit_log.mapping.json'),
      JSON.stringify({ ...simpleMappingJson, extraColumn: 'extra' })
    );

    const big = docLine(1, `, "big" : "${'x'.repeat(1_572_864)}"`);
    const a = await t.verifiedChunk({ batchId, lines: [docLine(2), big, docLine(3)] });

    await t.seed.batch(batchId, 1);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(result.exitCode).toBe(exitCodes.ok);
    expect(result.outcomes.map(o => [o.chunk, o.status, o.docs])).toEqual([[a.runId, 'done', 3]]);

    expect(result.perTable).toEqual([
      {
        table: 'audit_log_entries',
        chunks: 1,
        inserted: 3,
        updated: 0,
        duplicates: 0,
        rejected: 0,
      },
    ]);

    const inserts = t.calls.filter(c => c.sql.startsWith('INSERT INTO `audit_log_entries`'));

    expect(inserts.map(c => tupleCount(c.sql))).toEqual([1, 1, 1]);
    expect(inserts.some(c => c.sql.length > 1_500_000)).toBe(true);

    // With a 1 MiB packet the same row is a reject.
    const tight = await setup({
      config: { load: { batchMaxBytesMb: 1 } },
      packet: 1024 * 1024,
      rules: [
        [
          /FROM information_schema\.COLUMNS/,
          params =>
            params[1] === 'audit_log_entries' ? [...simpleSchemaRows.columns, extraColumn] : [],
        ],
      ],
    });

    await writeFile(
      join(tight.dir, 'mappings', 'audit_log.mapping.json'),
      JSON.stringify({ ...simpleMappingJson, extraColumn: 'extra' })
    );

    await tight.verifiedChunk({ batchId, lines: [docLine(2), big, docLine(3)] });
    await tight.seed.batch(batchId, 1);

    const rejected = await load({
      ctx: tight.ctx,
      store: tight.store,
      mysql: tight.mysql,
      collections: tight.collections,
      confirm: tight.confirm,
    });

    expect(rejected.perTable).toEqual([
      {
        table: 'audit_log_entries',
        chunks: 1,
        inserted: 2,
        updated: 0,
        duplicates: 0,
        rejected: 1,
      },
    ]);

    expect(
      tight.calls.find(c => c.sql.startsWith('INSERT IGNORE INTO `_msm_load_rejects`'))?.sql
    ).toContain('row larger than max_allowed_packet');
  });

  it('--batch-id without a batch manifest warns and loads with an unknown cutoff', async () => {
    const t = await setup();

    await t.verifiedChunk({ batchId });

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      batchIds: [batchId],
      confirm: t.confirm,
    });

    expect(result.exitCode).toBe(exitCodes.ok);

    expect(t.messages()).toContain(
      `warn: batch ${batchId} has no batch manifest; its cutoff is unknown`
    );

    expect(
      t.calls.find(c => c.sql.startsWith('INSERT IGNORE INTO `_msm_load_chunks`'))?.params[4]
    ).toBeNull();
  });

  it('a chunk that keeps failing is marked failed in the ledger and the run exits 2', async () => {
    const boom = Object.assign(new Error('Data too long for column'), {
      errno: 1406,
      sqlState: '22001',
    });

    const t = await setup({
      rules: [
        [
          /^INSERT INTO `audit_log_entries`/,
          () => {
            throw boom;
          },
        ],
      ],
      config: { load: { chunkAttempts: 2 } },
    });

    const a = await t.verifiedChunk({ batchId });

    await t.seed.batch(batchId, 1);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(result.exitCode).toBe(exitCodes.incomplete);

    expect(result.outcomes).toEqual([
      {
        chunk: a.runId,
        collection: 'audit_log',
        status: 'failed',
        code: 'mysql',
        error: 'Data too long for column',
      },
    ]);

    expect(t.ledger.rows[0]).toMatchObject({
      status: 'failed',
      error: 'Data too long for column',
      attempts: 2,
    });

    expect(t.messages()).toContain(`warn: ${a.runId} failed (mysql): Data too long for column`);
    expect(t.sqls('lock').at(-1)).toBe('SELECT RELEASE_LOCK(?)');
  });

  it('a fatal error in one chunk stops the run, releases the locks and rethrows', async () => {
    const denied = Object.assign(new Error('INSERT command denied'), {
      errno: 1142,
      sqlState: '42000',
    });

    const t = await setup({
      rules: [
        [
          /^INSERT INTO `audit_log_entries`/,
          () => {
            throw denied;
          },
        ],
      ],
    });

    await t.verifiedChunk({ batchId });
    await t.seed.batch(batchId, 1);

    await expect(
      load({
        ctx: t.ctx,
        store: t.store,
        mysql: t.mysql,
        collections: t.collections,
        confirm: t.confirm,
      })
    ).rejects.toBe(denied);

    expect(t.sqls('lock').at(-1)).toBe('SELECT RELEASE_LOCK(?)');
    expect(t.counts.ended).toBe(1);

    await (
      await acquireLock(t.dir, 'load', false)
    )();
  });

  it('a SIGTERM during the load ends it with 143 and leaves the ledger resumable', async () => {
    const controller = new AbortController();

    const t = await setup({
      signal: controller.signal,
      rules: [
        [
          /^COMMIT$/,
          () => {
            controller.abort('SIGTERM');

            return header(0);
          },
        ],
      ],
      config: { load: { batchRows: 2 } },
    });

    const a = await t.verifiedChunk({ batchId, lines: lines(5) });

    await t.seed.batch(batchId, 1);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(result.exitCode).toBe(exitCodes.sigterm);

    expect(result.outcomes).toEqual([
      { chunk: a.runId, collection: 'audit_log', status: 'interrupted', code: 'interrupted' },
    ]);

    expect(t.ledger.rows[0]).toMatchObject({ status: 'loading', lines_done: 2 });
    expect(t.sqls('lock').at(-1)).toBe('SELECT RELEASE_LOCK(?)');
  });

  it('a second load while one runs is refused by the state lock', async () => {
    const t = await setup();
    const release = await acquireLock(t.dir, 'load', false);

    await expect(
      load({ ctx: t.ctx, store: t.store, mysql: t.mysql, collections: t.collections })
    ).rejects.toMatchObject({
      msmCode: 'lock',
      message: expect.stringContaining('load already running'),
    });

    await release();
  });

  it('persists a forced replay before the older batch writes, surviving an interrupt', async () => {
    const controller = new AbortController();
    let commits = 0;

    // The first COMMIT belongs to the older batch's chunk; the signal lands right after it, before
    // the newer chunk starts.
    const t = await setup({
      signal: controller.signal,
      rules: [
        [
          /^COMMIT$/,
          () => {
            commits += 1;

            if (commits === 1) controller.abort('SIGINT');

            return header(0);
          },
        ],
      ],
      config: { load: { concurrency: 1 } },
    });

    const old = await t.verifiedChunk({ batchId: olderBatch });

    const recent = await t.verifiedChunk({
      batchId: newerBatch,
      mode: 'full-collection',
      lines: lines(4, 10),
    });

    await t.seed.batch(olderBatch, 1, { cutoff_utc: '2026-10-01T00:00:00Z' });
    await t.seed.batch(newerBatch, 1, { cutoff_utc: '2026-10-20T00:00:00Z' });

    const mappingSha256 = (await loadMapping(join(t.dir, 'mappings', 'audit_log.mapping.json')))
      .sha256;

    t.ledger.rows.push(
      ledgerRow({
        id: 9,
        batch_id: newerBatch,
        chunk_run_id: recent.runId,
        batch_cutoff_utc: '2026-10-20T00:00:00Z',
        status: 'loaded',
        lines_done: 4,
        rows_inserted: 4,
        manifest_sha256: sha256(JSON.stringify(recent.manifest)),
        mapping_sha256: mappingSha256,
        exported_count: 4,
      })
    );

    const first = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
      reload: true,
    });

    expect(first.exitCode).toBe(exitCodes.sigint);

    // The older chunk's rows are committed (its closing UPDATE ran under the signal); the newer
    // chunk never started.
    expect(first.outcomes.map(o => [o.chunk, o.status])).toEqual([
      [old.runId, 'interrupted'],
      [recent.runId, 'interrupted'],
    ]);

    expect(t.ledger.rows.find(r => r.chunk_run_id === old.runId)).toMatchObject({
      lines_done: 3,
      rows_inserted: 3,
    });

    // The obligation to replay is in the ledger, not in the memory of the process that died.
    expect(t.ledger.rows.find(r => r.id === 9)).toMatchObject({
      status: 'loading',
      manifest_sha256: replayPendingSha,
      lines_done: 4,
    });

    const second = await setup({ ledger: t.ledger.rows });

    for (const [k, v] of t.store.objects) second.store.objects.set(k, v);

    const result = await load({
      ctx: second.ctx,
      store: second.store,
      mysql: second.mysql,
      collections: second.collections,
      confirm: second.confirm,
    });

    expect(result.exitCode).toBe(exitCodes.ok);

    expect(result.outcomes.map(o => [o.chunk, o.status, o.docs])).toEqual([
      [old.runId, 'done', 0],
      [recent.runId, 'done', 4],
    ]);

    const resets = second.calls
      .filter(c => c.sql.startsWith('UPDATE `_msm_load_chunks` SET `lines_done` = 0'))
      .map(c => c.params[2]);

    expect(resets).toEqual([9]);

    expect(second.ledger.rows.find(r => r.id === 9)).toMatchObject({
      status: 'loaded',
      lines_done: 4,
      rows_inserted: 4,
      manifest_sha256: sha256(JSON.stringify(recent.manifest)),
    });
  });

  it('a ledger that changed while waiting for the prompt or the locks stops the run', async () => {
    const t = await setup();
    const a = await t.verifiedChunk({ batchId });

    await t.seed.batch(batchId, 1);

    // Another loader finishes the same chunk between the confirmed plan and this run's GET_LOCK.
    const original = t.mysql.connect.bind(t.mysql);

    t.mysql.connect = async () => {
      t.ledger.rows.push(
        ledgerRow({
          id: 5,
          chunk_run_id: a.runId,
          manifest_sha256: sha256(JSON.stringify(a.manifest)),
          mapping_sha256: (await loadMapping(join(t.dir, 'mappings', 'audit_log.mapping.json')))
            .sha256,
          exported_count: 3,
          lines_done: 3,
          rows_inserted: 3,
        })
      );

      return original();
    };

    await expect(
      load({
        ctx: t.ctx,
        store: t.store,
        mysql: t.mysql,
        collections: t.collections,
        confirm: t.confirm,
      })
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: 'the load ledger changed while waiting for the prompt or the locks; rerun load',
    });

    expect(t.sqls().some(s => s.startsWith('INSERT IGNORE INTO `_msm_load_chunks`'))).toBe(false);
    expect(t.sqls('lock').at(-1)).toBe('SELECT RELEASE_LOCK(?)');
  });

  it('refuses a --load-run-id the ledger column cannot hold before anything runs', async () => {
    const t = await setup();

    await t.verifiedChunk({ batchId });
    await t.seed.batch(batchId, 1);

    for (const loadRunId of ['x'.repeat(65), 'run with spaces', 'r\u00fcn', '']) {
      await expect(
        load({
          ctx: t.ctx,
          store: t.store,
          mysql: t.mysql,
          collections: t.collections,
          loadRunId,
          confirm: t.confirm,
        })
      ).rejects.toMatchObject({
        msmCode: 'config',
        fatal: true,
        message: expect.stringContaining('1 to 64 printable ASCII characters'),
      });
    }

    expect(t.calls).toEqual([]);
  });

  it('runs the ledger DDL only for missing ledger tables, so a DML-only loader works', async () => {
    const ledgerColumns = [
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
    ];

    const t = await setup({
      rules: [
        [
          /FROM information_schema\.COLUMNS/,
          params =>
            params[1] === 'audit_log_entries'
              ? simpleSchemaRows.columns
              : params[1] === '_msm_load_keys'
                ? []
                : ledgerColumns,
        ],
      ],
    });

    await t.verifiedChunk({ batchId });
    await t.seed.batch(batchId, 1);

    const result = await load({
      ctx: t.ctx,
      store: t.store,
      mysql: t.mysql,
      collections: t.collections,
      confirm: t.confirm,
    });

    expect(result.exitCode).toBe(exitCodes.ok);

    expect(
      t
        .sqls('pool')
        .filter(s => s.startsWith('CREATE TABLE'))
        .map(s => /`(_msm_\w+)`/.exec(s)?.[1])
    ).toEqual(['_msm_load_keys']);
  });
});
