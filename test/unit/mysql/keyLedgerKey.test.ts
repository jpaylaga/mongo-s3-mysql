import { describe, expect, it } from 'vitest';
import keyLedgerKey from '../../../src/mysql/keyLedgerKey.js';
import ledgerDdl from '../../../src/mysql/ledgerDdl.js';

describe('keyLedgerKey', () => {
  it('is the one width and collation the key ledger, the deep check, the shape check and infer agree on', () => {
    expect(keyLedgerKey).toEqual({ maxChars: 760, collation: 'utf8mb4_0900_bin' });
    expect(ledgerDdl[2]).toContain(`\`key_value\` VARCHAR(${keyLedgerKey.maxChars}) NOT NULL`);
    expect(ledgerDdl[2]).toContain(`COLLATE=${keyLedgerKey.collation}`);
  });
});
