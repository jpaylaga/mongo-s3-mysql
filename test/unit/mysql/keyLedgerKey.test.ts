import { describe, expect, it } from 'vitest';
import keyLedgerKey from '#mysql/keyLedgerKey';
import ledgerDdl from '#mysql/ledgerDdl';

describe('keyLedgerKey', () => {
  it('is the one width and collation the key ledger, deep check, shape check and infer use', () => {
    expect(keyLedgerKey).toEqual({ maxChars: 760, collation: 'utf8mb4_0900_bin' });
    expect(ledgerDdl[2]).toContain(`\`key_value\` VARCHAR(${keyLedgerKey.maxChars}) NOT NULL`);
    expect(ledgerDdl[2]).toContain(`COLLATE=${keyLedgerKey.collation}`);
  });
});
