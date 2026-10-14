import type { Pool } from 'mysql2/promise';
import type { LedgerRow } from '../types.js';
import isNoSuchTable from './isNoSuchTable.js';
import toSafeNumber from './toSafeNumber.js';

const counters = ['id', 'exported_count', 'lines_done', 'rows_inserted', 'rows_updated', 'duplicates_skipped', 'rows_rejected', 'cast_errors', 'attempts'] as const;

/**
 * Every ledger row of one target table, oldest first. A database without a ledger yet (the first load, or a
 * reconcile before any load) reads as empty rather than as an error.
 */
export default async function readLedger(pool: Pool, name: string): Promise<LedgerRow[]> {
  let rows: Record<string, unknown>[];
  try {
    const [result] = await pool.query('SELECT * FROM `_msm_load_chunks` WHERE `target_table` = ? ORDER BY `id`', [name]);
    rows = result as Record<string, unknown>[];
  } catch (err) {
    if (isNoSuchTable(err)) return [];
    throw err;
  }
  return rows.map((r) => {
    const row = { ...r } as Record<string, unknown>;
    for (const c of counters) row[c] = toSafeNumber(r[c], `_msm_load_chunks.${c}`);
    return row as unknown as LedgerRow;
  });
}
