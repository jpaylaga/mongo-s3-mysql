import fitIdentifier from '#mysql/fitIdentifier';
import keyLedgerKey from '#mysql/keyLedgerKey';
import quoteId from '#mysql/quoteId';
import msmError from '#runtime/msmError';
import type { ColumnMapping, Mapping } from '#types';

/**
 * Column types when the mapping carries no `sqlType`: the widest safe type for each cast
 * (docs/mapping.md, "What infer writes").
 */
function defaultType(col: ColumnMapping): string {
  switch (col.cast) {
    case 'string':
      return 'VARCHAR(255)';
    case 'int':
      return 'INT';
    case 'bigint':
      return 'BIGINT';
    case 'double':
      return 'DOUBLE';
    case 'decimal':
      return 'DECIMAL(65,30)';
    case 'bool':
      return 'TINYINT(1)';
    case 'datetime':
      return `DATETIME(${col.fsp ?? 0})`;
    case 'objectId':
      return 'CHAR(24)';
    case 'json':
      return 'JSON';
    default:
      return 'JSON';
  }
}

export interface DdlOptions {
  /**
   * `load.keyLedger`: while keys are recorded, a string key wider than the ledger's `key_value` is
   * refused before any table exists.
   */
  keyLedger?: boolean;
}

/**
 * The key column's type: ObjectIds are ASCII hex; a string key needs a NO PAD binary comparison,
 * which is `utf8mb4_0900_bin` on VARCHAR and the character set itself on VARBINARY (a COLLATE
 * clause there is an error). CHAR and BINARY pad or strip trailing bytes, and a key over the
 * ledger's width cannot be recorded, so the shape check would refuse the table this DDL created;
 * both are refused here instead, before any table exists.
 */
function keyType(collection: string, key: Mapping['key'], options: DdlOptions): string {
  switch (key.cast) {
    case 'objectId':
      return `${key.sqlType ?? 'CHAR(24)'} CHARACTER SET ascii COLLATE ascii_bin`;
    case 'string': {
      const sqlType = key.sqlType ?? 'VARCHAR(255)';
      const base = (/^[A-Za-z]+/.exec(sqlType)?.[0] ?? '').toUpperCase();

      if (base !== 'VARBINARY' && base !== 'VARCHAR')
        throw msmError(
          'config',
          `mapping ${collection}: a string key needs VARCHAR or VARBINARY, not ` +
            `${base} (key.sqlType ${sqlType}): it pads or strips trailing bytes`,
          { fatal: true }
        );

      // mappingSchema allows only `TYPE(n)` shapes
      const length = Number(/^[A-Za-z]+\((\d+)/.exec(sqlType)?.[1] ?? NaN);

      if (options.keyLedger === true && length > keyLedgerKey.maxChars) {
        throw msmError(
          'config',
          `mapping ${collection}: key.sqlType ${sqlType} holds ${length} ` +
            `characters, more than the ${keyLedgerKey.maxChars} the key ledger ` +
            'stores; shorten it or set load.keyLedger false',
          { fatal: true }
        );
      }

      return base === 'VARBINARY' ? sqlType : `${sqlType} COLLATE ${keyLedgerKey.collation}`;
    }
    default:
      return key.sqlType ?? 'BIGINT';
  }
}

const createTable = (name: string, lines: string[]): string =>
  `CREATE TABLE IF NOT EXISTS ${quoteId(name)} (\n  ${lines.join(',\n  ')}\n) ` +
  'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;';

/**
 * `CREATE TABLE IF NOT EXISTS` for the mapping's table and child tables: a surrogate `id` plus a
 * nullable UNIQUE key column, so application rows and imported rows can share the table. A mapped
 * column named `id` is refused unless it is the key itself, which then becomes the primary key with
 * no surrogate.
 */
export default function mappingToDdl(mapping: Mapping, options: DdlOptions = {}): string[] {
  const keyIsId = mapping.key.column.toLowerCase() === 'id';

  const clash = [
    ...mapping.columns.map(c => c.column),
    mapping.runIdColumn,
    mapping.chunkColumn,
    mapping.extraColumn,
  ].find(c => c !== null && c.toLowerCase() === 'id');

  if (clash !== undefined)
    throw msmError(
      'config',
      `mapping ${mapping.collection}: column "${clash}" is reserved for the ` +
        'surrogate id; only the key may be named id',
      { fatal: true }
    );

  const lines: string[] = [];

  if (!keyIsId) lines.push(`${quoteId('id')} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`);

  for (const col of mapping.columns)
    lines.push(`${quoteId(col.column)} ${col.sqlType ?? defaultType(col)} NULL`);

  lines.push(
    `${quoteId(mapping.key.column)} ` +
      `${keyType(mapping.collection, mapping.key, options)} ` +
      `${keyIsId ? 'NOT NULL' : 'NULL'}`
  );

  if (mapping.runIdColumn !== null) lines.push(`${quoteId(mapping.runIdColumn)} VARCHAR(64) NULL`);

  if (mapping.chunkColumn !== null)
    lines.push(`${quoteId(mapping.chunkColumn)} BIGINT UNSIGNED NULL`);

  if (mapping.extraColumn !== null) lines.push(`${quoteId(mapping.extraColumn)} JSON NULL`);

  lines.push(`PRIMARY KEY (${quoteId(keyIsId ? mapping.key.column : 'id')})`);

  // Index names are derived from two identifiers, so they can pass 64 characters; fitIdentifier
  // keeps them unique.
  if (!keyIsId)
    lines.push(
      'UNIQUE KEY ' +
        `${quoteId(fitIdentifier(`uq_${mapping.table}_${mapping.key.column}`))} ` +
        `(${quoteId(mapping.key.column)})`
    );

  if (mapping.chunkColumn !== null)
    lines.push(
      `KEY ${quoteId(fitIdentifier(`ix_${mapping.table}_${mapping.chunkColumn}`))} ` +
        `(${quoteId(mapping.chunkColumn)})`
    );

  const statements = [createTable(mapping.table, lines)];

  for (const child of mapping.children) {
    // The surrogate `id` is declared first, so the parent and index columns must not be named `id`
    // either.
    const childClash = [
      child.parentColumn,
      child.indexColumn,
      ...child.columns.map(c => c.column),
    ].find(c => c !== null && c.toLowerCase() === 'id');

    if (childClash !== undefined)
      throw msmError(
        'config',
        `mapping ${mapping.collection}: child ${child.table} column ` +
          `"${childClash}" is reserved for the surrogate id`,
        { fatal: true }
      );

    const childLines = [
      `${quoteId('id')} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`,
      `${quoteId(child.parentColumn)} ` +
        `${keyType(mapping.collection, mapping.key, options)} NOT NULL`,
    ];

    if (child.indexColumn !== null)
      childLines.push(`${quoteId(child.indexColumn)} INT UNSIGNED NOT NULL`);

    for (const col of child.columns)
      childLines.push(`${quoteId(col.column)} ${col.sqlType ?? defaultType(col)} NULL`);

    childLines.push(`PRIMARY KEY (${quoteId('id')})`);

    // Without an index column several elements share one parent key, so the parent index cannot be
    // unique.
    const parentCols =
      child.indexColumn === null
        ? quoteId(child.parentColumn)
        : `${quoteId(child.parentColumn)}, ${quoteId(child.indexColumn)}`;

    childLines.push(
      child.indexColumn === null
        ? `KEY ${quoteId(fitIdentifier(`ix_${child.table}_parent`))} (${parentCols})`
        : `UNIQUE KEY ${quoteId(fitIdentifier(`uq_${child.table}_parent`))} (${parentCols})`
    );

    statements.push(createTable(child.table, childLines));
  }

  return statements;
}
