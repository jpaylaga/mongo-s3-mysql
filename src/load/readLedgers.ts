import type { Pool } from 'mysql2/promise';
import readLedger from '#mysql/readLedger';
import withRetry from '#runtime/withRetry';
import type { LedgerRow, LoadTarget, RunContext } from '#types';

/**
 * The load ledger of every target table, read once per table (several collections may share one).
 */
export default async function readLedgers(
  ctx: RunContext,
  pool: Pool,
  targets: Map<string, LoadTarget>
): Promise<Map<string, LedgerRow[]>> {
  const ledgers = new Map<string, LedgerRow[]>();

  for (const target of targets.values()) {
    const { name } = target.table;

    if (!ledgers.has(name))
      ledgers.set(
        name,
        await withRetry(ctx, { source: 'mysql', name: 'readLedger' }, () => readLedger(pool, name))
      );
  }

  return ledgers;
}
