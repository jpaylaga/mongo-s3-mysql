import { describe, expect, it } from 'vitest';
import summarizePerTable from '../../../src/load/summarizePerTable.js';
import { fakeMysql } from '../mysql/fakeMysql.js';
import { ledgerRow } from './fixtures.js';

const asDb = (rows: ReturnType<typeof ledgerRow>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])));

describe('summarizePerTable', () => {
  it('sums the ledger counters of the selected chunks per table, and reads nothing for a table that got no chunk', async () => {
    const rows = [
      ledgerRow({ id: 1, chunk_run_id: 'r1', rows_inserted: 10, rows_updated: 2, duplicates_skipped: 1, rows_rejected: 3 }),
      ledgerRow({ id: 2, chunk_run_id: 'r2', rows_inserted: 5, rows_updated: 0, duplicates_skipped: 0, rows_rejected: 0 }),
      ledgerRow({ id: 3, chunk_run_id: 'other-run', rows_inserted: 99 }),
    ];
    const { pool, calls } = fakeMysql([[/FROM `_msm_load_chunks` WHERE `target_table`/, asDb(rows)]]);
    const byTable = new Map([['audit_log_entries', new Set(['r1', 'r2'])], ['empty_table', new Set<string>()]]);
    expect(await summarizePerTable(pool, byTable)).toEqual([
      { table: 'audit_log_entries', chunks: 2, inserted: 15, updated: 2, duplicates: 1, rejected: 3 },
      { table: 'empty_table', chunks: 0, inserted: 0, updated: 0, duplicates: 0, rejected: 0 },
    ]);
    // One ledger read for the table with chunks, none for the empty one.
    expect(calls).toHaveLength(1);
    expect(await summarizePerTable(pool, new Map([['empty_table', new Set<string>()]]))).toEqual([{ table: 'empty_table', chunks: 0, inserted: 0, updated: 0, duplicates: 0, rejected: 0 }]);
    expect(calls).toHaveLength(1);
  });
});
