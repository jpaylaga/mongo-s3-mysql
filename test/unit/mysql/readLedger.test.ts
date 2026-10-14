import type { Pool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import readLedger from '#mysql/readLedger';

/** A ledger row the way mysql2 returns it under bigNumberStrings and dateStrings. */
const dbRow = (over: Record<string, unknown> = {}) => ({
  id: '17',
  target_table: 'audit_log_entries',
  collection: 'audit_log',
  batch_id: 'app-archive-full-20261013T020304Z',
  chunk_run_id:
    'app-archive-full-20261013T020304Z-audit_log-timestamp-window-' +
    '20260302T000000Z-20260303T000000Z',
  batch_cutoff_utc: '2026-10-13T02:00:00Z',
  manifest_key: 'mongo-archive/manifests/x/run_id=r.json',
  manifest_sha256: 'a'.repeat(64),
  mapping_sha256: 'b'.repeat(64),
  exported_count: '48211',
  lines_done: '48211',
  rows_inserted: '48000',
  rows_updated: '200',
  duplicates_skipped: '1',
  rows_rejected: '10',
  cast_errors: '0',
  status: 'loaded',
  attempts: '1',
  load_run_id: 'load-20261013T040000Z',
  error: null,
  started_at: '2026-10-13 04:00:00.000',
  updated_at: '2026-10-13 04:05:00.000',
  finished_at: '2026-10-13 04:05:00.000',
  ...over,
});

function fakePool(answer: (sql: string, params: unknown[]) => Promise<unknown[]>) {
  const calls: { sql: string; params: unknown[] }[] = [];

  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });

      return [await answer(sql, params), []];
    },
  } as unknown as Pool;

  return { pool, calls };
}

describe('readLedger', () => {
  it('selects the table rows and converts the string counters to numbers', async () => {
    const { pool, calls } = fakePool(async () => [
      dbRow(),
      dbRow({
        id: '18',
        status: 'loading',
        lines_done: '1000',
        finished_at: null,
        error: 'mysql: lost',
      }),
    ]);

    const rows = await readLedger(pool, 'audit_log_entries');

    expect(calls[0]?.sql).toMatch(
      /FROM `_msm_load_chunks` WHERE `target_table` = \? ORDER BY `id`/
    );

    expect(calls[0]?.params).toEqual(['audit_log_entries']);
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      id: 17,
      exported_count: 48211,
      lines_done: 48211,
      rows_inserted: 48000,
      rows_updated: 200,
      duplicates_skipped: 1,
      rows_rejected: 10,
      cast_errors: 0,
      attempts: 1,
      status: 'loaded',
      error: null,
      finished_at: '2026-10-13 04:05:00.000',
    });

    expect(rows[1]).toMatchObject({
      id: 18,
      status: 'loading',
      lines_done: 1000,
      finished_at: null,
      error: 'mysql: lost',
    });

    for (const c of [
      'id',
      'exported_count',
      'lines_done',
      'rows_inserted',
      'rows_updated',
      'duplicates_skipped',
      'rows_rejected',
      'cast_errors',
      'attempts',
    ]) {
      expect(typeof (rows[0] as unknown as Record<string, unknown>)[c]).toBe('number');
    }
  });

  it('reads as empty when the ledger table does not exist yet', async () => {
    const { pool } = fakePool(async () => {
      throw Object.assign(new Error("Table 'archive._msm_load_chunks' doesn't exist"), {
        errno: 1146,
        code: 'ER_NO_SUCH_TABLE',
        sqlState: '42S02',
      });
    });

    expect(await readLedger(pool, 'audit_log_entries')).toEqual([]);
  });

  it('propagates other errors', async () => {
    const { pool } = fakePool(async () => {
      throw Object.assign(new Error('denied'), { errno: 1142, sqlState: '42000' });
    });

    await expect(readLedger(pool, 'audit_log_entries')).rejects.toThrow('denied');
  });

  it('refuses a counter beyond 2^53 - 1 instead of rounding it', async () => {
    const { pool } = fakePool(async () => [dbRow({ rows_inserted: '9007199254740992' })]);

    await expect(readLedger(pool, 'audit_log_entries')).rejects.toThrow(
      /_msm_load_chunks.rows_inserted 9007199254740992 is outside 0\.\.2\^53-1/
    );

    const { pool: edge } = fakePool(async () => [dbRow({ rows_inserted: '9007199254740991' })]);

    expect((await readLedger(edge, 'audit_log_entries'))[0]?.rows_inserted).toBe(9007199254740991);
  });
});
