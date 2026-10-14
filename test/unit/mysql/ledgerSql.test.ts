import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ledgerDdl from '../../../src/mysql/ledgerDdl.js';

/** docs/ledger.sql is what a DBA runs by hand; it must be the statements the loader runs, and nothing else. */
describe('docs/ledger.sql', () => {
  it('holds exactly the ledger DDL, one statement per table, terminated with semicolons', async () => {
    const text = await readFile(fileURLToPath(new URL('../../../docs/ledger.sql', import.meta.url)), 'utf8');
    const statements = text.split('\n').filter((l) => !l.startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter((s) => s.length > 0);
    expect(statements).toEqual(ledgerDdl.map((s) => s.trim()));
  });
});
