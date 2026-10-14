import type { Pool } from 'mysql2/promise';
import ledgerDdl from './ledgerDdl.js';
import readTableInfo from './readTableInfo.js';

/** The ledger tables in `ledgerDdl` order; the key ledger is last so it can be left out. */
const ledgerTables = ['_msm_load_chunks', '_msm_load_rejects', '_msm_load_keys'];

/**
 * The `CREATE TABLE` statements for the ledger tables that do not exist yet. MySQL checks the CREATE privilege
 * before IF NOT EXISTS, so a DML-only loader must not be handed a statement for a table that is already there.
 */
export default async function missingLedgerDdl(pool: Pool, database: string, keyLedger: boolean): Promise<string[]> {
  const wanted = ledgerTables.slice(0, keyLedger ? 3 : 2);
  const statements: string[] = [];
  for (const [i, name] of wanted.entries()) {
    if ((await readTableInfo(pool, database, name)) === null) statements.push(ledgerDdl[i] as string);
  }
  return statements;
}
