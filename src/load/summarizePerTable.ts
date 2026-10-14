import type { Pool } from 'mysql2/promise';
import readLedger from '../mysql/readLedger.js';
import type { LoadResult } from '../types.js';

/**
 * The per-table summary of a load: the ledger counters of the chunks this run selected, summed per table.
 * `byTable` maps each target table to the run ids it got; a table that got none has nothing to read and zero counters.
 */
export default async function summarizePerTable(pool: Pool, byTable: Map<string, Set<string>>): Promise<LoadResult['perTable']> {
  const result: LoadResult['perTable'] = [];
  for (const [table, runIds] of byTable) {
    const rows = runIds.size === 0 ? [] : (await readLedger(pool, table)).filter((r) => runIds.has(r.chunk_run_id));
    const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + pick(r), 0);
    result.push({ table, chunks: runIds.size, inserted: sum((r) => r.rows_inserted), updated: sum((r) => r.rows_updated), duplicates: sum((r) => r.duplicates_skipped), rejected: sum((r) => r.rows_rejected) });
  }
  return result;
}
