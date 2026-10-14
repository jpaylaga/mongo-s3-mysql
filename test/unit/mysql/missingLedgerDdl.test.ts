import { describe, expect, it } from 'vitest';
import ledgerDdl from '../../../src/mysql/ledgerDdl.js';
import missingLedgerDdl from '../../../src/mysql/missingLedgerDdl.js';
import { fakeMysql, type Rule } from './fakeMysql.js';

/** information_schema answers for the ledger tables that exist; the index query is never reached for a missing one. */
const existing = (names: string[]): Rule[] => [
  [/FROM information_schema\.COLUMNS/, (params) => (names.includes(params[1] as string) ? [{ COLUMN_NAME: 'id', DATA_TYPE: 'bigint', COLUMN_TYPE: 'bigint unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', COLLATION_NAME: null, CHARACTER_MAXIMUM_LENGTH: null, CHARACTER_OCTET_LENGTH: null, NUMERIC_PRECISION: '20', NUMERIC_SCALE: '0', DATETIME_PRECISION: null }] : [])],
  [/FROM information_schema\.STATISTICS/, []],
];

describe('missingLedgerDdl', () => {
  it('returns the CREATE TABLE of each ledger table that does not exist, in ledger order, leaving the key ledger out when it is off', async () => {
    expect(await missingLedgerDdl(fakeMysql(existing([])).pool, 'archive', true)).toEqual(ledgerDdl);
    expect(await missingLedgerDdl(fakeMysql(existing([])).pool, 'archive', false)).toEqual(ledgerDdl.slice(0, 2));
    expect(await missingLedgerDdl(fakeMysql(existing(['_msm_load_chunks', '_msm_load_rejects'])).pool, 'archive', true)).toEqual([ledgerDdl[2]]);
    // Nothing to create: a DML-only loader is never handed a CREATE for a table that is there (MySQL checks the privilege before IF NOT EXISTS).
    expect(await missingLedgerDdl(fakeMysql(existing(['_msm_load_chunks', '_msm_load_rejects', '_msm_load_keys'])).pool, 'archive', true)).toEqual([]);
  });
});
