import keyLedgerKey from '#mysql/keyLedgerKey';
import type { ColumnInfo, Mapping } from '#types';

/** The collation `_msm_load_keys.key_value` and the deep check's temporary table carry. */
const ledgerCollation = keyLedgerKey.collation;

/** `utf8mb4_0900_ai_ci` -> `utf8mb4`, `ascii_bin` -> `ascii`; `binary` is its own character set. */
const charsetOf = (collation: string): string =>
  collation === 'binary' ? 'binary' : (collation.split('_')[0] ?? collation);

/**
 * SQL expressions that compare the target table's key column with the ledger's key text in both
 * directions so each side's index is usable: the conversion always sits on the other side. Key
 * casts are objectId, string and bigint, so a key column is either text, binary or an integer.
 */
export default function keyExpr(
  column: ColumnInfo | null,
  cast: Mapping['key']['cast']
): {
  /**
   * Ledger text (`k.key_value`) converted to the key column's type, so `t.key = <this>` uses
   * `t.key`'s index.
   */
  toKey(text: string): string;
  /**
   * The key column converted to ledger text, so `k.key_value = <this>` uses the ledger's primary
   * key.
   */
  toText(key: string): string;
} {
  const numeric =
    cast === 'bigint' ||
    (column !== null && column.collation === null && /int/.test(column.dataType));

  if (numeric) {
    const unsigned = column !== null && /unsigned/.test(column.dataType);

    return {
      toKey: text => `CAST(${text} AS ${unsigned ? 'UNSIGNED' : 'SIGNED'})`,
      toText: key => `CAST(${key} AS CHAR CHARACTER SET utf8mb4) COLLATE ${ledgerCollation}`,
    };
  }

  const collation = column?.collation ?? ledgerCollation;
  const charset = charsetOf(collation);

  return {
    toKey: text =>
      charset === 'binary'
        ? `CONVERT(${text} USING binary)`
        : `CONVERT(${text} USING ${charset}) COLLATE ${collation}`,
    toText: key => `CONVERT(${key} USING utf8mb4) COLLATE ${ledgerCollation}`,
  };
}
