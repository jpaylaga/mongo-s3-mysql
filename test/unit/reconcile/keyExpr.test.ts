import { describe, expect, it } from 'vitest';
import keyExpr from '#reconcile/keyExpr';
import { col } from '../mysql/fakeTables.js';

describe('keyExpr', () => {
  it('converts ledger text to the key column charset and collation so the index is usable', () => {
    const e = keyExpr(
      col('source_mongo_id', 'char', { collation: 'utf8mb4_0900_ai_ci', charLength: 24 }),
      'objectId'
    );

    expect(e.toKey('k.`key_value`')).toBe(
      'CONVERT(k.`key_value` USING utf8mb4) COLLATE utf8mb4_0900_ai_ci'
    );

    expect(e.toText('`t`.`source_mongo_id`')).toBe(
      'CONVERT(`t`.`source_mongo_id` USING utf8mb4) COLLATE utf8mb4_0900_bin'
    );

    const ascii = keyExpr(col('mongo_id', 'char', { collation: 'ascii_bin' }), 'objectId');

    expect(ascii.toKey('i.`id`')).toBe('CONVERT(i.`id` USING ascii) COLLATE ascii_bin');
  });

  it('binary key columns convert to binary without a collation clause', () => {
    const e = keyExpr(col('k', 'varbinary', { collation: 'binary' }), 'string');

    expect(e.toKey('x')).toBe('CONVERT(x USING binary)');
    expect(e.toText('x')).toBe('CONVERT(x USING utf8mb4) COLLATE utf8mb4_0900_bin');
  });

  it('integer keys cast the text to a number and the number to ledger text', () => {
    const signed = keyExpr(col('seq', 'bigint'), 'bigint');

    expect(signed.toKey('k.`key_value`')).toBe('CAST(k.`key_value` AS SIGNED)');

    expect(signed.toText('`t`.`seq`')).toBe(
      'CAST(`t`.`seq` AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_0900_bin'
    );

    expect(keyExpr(col('seq', 'bigint unsigned'), 'bigint').toKey('x')).toBe('CAST(x AS UNSIGNED)');
    // The cast decides when the column is unknown: a bigint key is numeric even without column
    // info.
    expect(keyExpr(null, 'bigint').toKey('x')).toBe('CAST(x AS SIGNED)');
  });

  it('falls back to the ledger collation when the column is unknown', () => {
    expect(keyExpr(null, 'string').toKey('x')).toBe(
      'CONVERT(x USING utf8mb4) COLLATE utf8mb4_0900_bin'
    );
  });
});
