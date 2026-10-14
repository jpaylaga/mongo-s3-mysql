import mappingToDdl from '#mapping/mappingToDdl';
import keyLedgerKey from '#mysql/keyLedgerKey';
import errorMessage from '#runtime/errorMessage';
import type {
  ColumnInfo,
  ColumnMapping,
  Mapping,
  ShapeOptions,
  ShapeReport,
  TableInfo,
} from '#types';

const stringTypes = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext']);
const binaryTypes = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);

const numericTypes = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'bigint',
  'decimal',
  'numeric',
  'float',
  'double',
  'bit',
]);

const fractionalTypes = new Set(['datetime', 'timestamp', 'time']);
/** An ObjectId is written as 24 hex characters, whatever the column. */
const objectIdChars = 24;

const baseOf = (col: ColumnInfo): string => col.dataType.split(' ')[0] ?? '';

/**
 * The current UTC offset of an IANA zone as `+HH:MM`, the form `mysql.sessionTimeZone` takes, so
 * the two can be compared.
 */
function zoneOffset(timeZone: string, at: Date): string | null {
  try {
    const name =
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
        .formatToParts(at)
        .find(p => p.type === 'timeZoneName')?.value ?? '';

    const m = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);

    if (m === null) return null;

    return m[1] === undefined
      ? '+00:00'
      : `${m[1]}${(m[2] as string).padStart(2, '0')}:${m[3] ?? '00'}`;
  } catch {
    return null;
  }
}

/**
 * A column that can never take what the cast produces, whatever the value: an ObjectId (24 hex
 * characters) on a numeric column or one shorter than 24, JSON text on a numeric column. Reported
 * before the load starts instead of failing chunk after chunk.
 */
function familyProblem(
  table: string,
  column: string,
  cast: ColumnMapping['cast'] | 'objectId',
  live: ColumnInfo
): string | null {
  const base = baseOf(live);

  if (cast === 'objectId') {
    if (numericTypes.has(base))
      return `${table}.${column}: an ObjectId (24 hex characters) cannot go into ${live.dataType}`;

    if (stringTypes.has(base) && live.charLength !== null && live.charLength < objectIdChars)
      return (
        `${table}.${column}: an ObjectId is ${objectIdChars} characters, ` +
        `${live.dataType}(${live.charLength}) is shorter`
      );

    if (binaryTypes.has(base) && live.octetLength !== null && live.octetLength < objectIdChars)
      return (
        `${table}.${column}: an ObjectId is ${objectIdChars} hex characters, ` +
        `${live.dataType}(${live.octetLength}) is shorter`
      );
  }

  if (cast === 'json' && numericTypes.has(base))
    return `${table}.${column}: a json cast cannot go into ${live.dataType}`;

  return null;
}

/**
 * A string key must compare byte for byte and without trailing-space padding: `*_0900_bin` and
 * `binary` (BINARY, VARBINARY and the BLOB types, which information_schema reports without a
 * collation) are NO PAD and binary, while `utf8mb4_bin`, `utf8mb3_bin`, `latin1_bin` and
 * `ascii_bin` are PAD SPACE, so `'a'` and `'a '` would share one row. The `_0900_as_cs` collations
 * are NO PAD but compare UCA weights, so canonically equivalent strings would share a row too. CHAR
 * and BINARY columns strip or pad trailing bytes outright.
 */
function stringKeyProblem(table: string, column: string, col: ColumnInfo): string | null {
  const coll = col.collation ?? '';
  const noPad = coll === 'binary' || coll.endsWith('_0900_bin');

  if (!noPad)
    return (
      `${table}.${column}: a string key needs a NO PAD binary collation ` +
      `(utf8mb4_0900_bin, or a VARBINARY column; has ${coll || 'none'}): utf8mb4_bin ` +
      'and ascii_bin pad trailing spaces, and the _0900_as_cs collations fold ' +
      'canonically equivalent strings'
    );

  const base = baseOf(col);

  if (base === 'char' || base === 'binary')
    return (
      `${table}.${column}: a string key needs VARCHAR or VARBINARY, not ` +
      `${base.toUpperCase()}, which pads or strips trailing bytes`
    );

  return null;
}

function checkMappedColumns(
  table: TableInfo,
  columns: ColumnMapping[],
  options: ShapeOptions,
  report: ShapeReport
): void {
  for (const col of columns) {
    const live = table.columns.get(col.column);

    if (live === undefined) {
      report.problems.push(`${table.name}: mapped column ${col.column} is missing`);

      continue;
    }

    if (!live.nullable && col.default === undefined)
      report.warnings.push(
        `${table.name}.${col.column} is NOT NULL and the mapping has no default: a ` +
          'missing, null or uncastable field rejects the line'
      );

    const family = familyProblem(table.name, col.column, col.cast, live);

    if (family !== null) report.problems.push(family);

    if (col.cast === 'datetime') {
      const base = baseOf(live);

      // Only the fractional types round; DATE takes the literal with a note and a string column
      // stores it verbatim.
      if (fractionalTypes.has(base) && (col.fsp ?? 0) > (live.fsp ?? 0))
        report.problems.push(
          `${table.name}.${col.column}: mapping fsp ${col.fsp} exceeds the ` +
            `column's ${live.fsp ?? 0}; MySQL would round`
        );

      const literal = 19 + ((col.fsp ?? 0) > 0 ? (col.fsp ?? 0) + 1 : 0);

      if (stringTypes.has(base) && live.charLength !== null && live.charLength < literal) {
        report.problems.push(
          `${table.name}.${col.column}: a datetime literal with fsp ${col.fsp ?? 0}` +
            ` is ${literal} characters, ${live.dataType}(${live.charLength}) is ` +
            'shorter'
        );
      }

      if (base === 'timestamp') {
        // MySQL reads the literal in the session time_zone: a cast zone with another offset shifts
        // every row, silently, so both values are named.
        const zone = col.timezone ?? 'UTC';
        const session = options.sessionTimeZone ?? '+00:00';
        const offset = zoneOffset(zone, options.now ?? new Date());

        if (offset !== session) {
          report.warnings.push(
            `${table.name}.${col.column} is TIMESTAMP: the cast writes ${zone} ` +
              `wall-clock values (currently ${offset ?? 'an unknown offset'}) and ` +
              `mysql.sessionTimeZone is ${session}, so MySQL reads them in another ` +
              `zone; set both to the application's connection time_zone`
          );
        }
      }
    }
  }
}

/**
 * The provenance columns get values the mapping cannot shape: the chunk column a BIGINT UNSIGNED
 * ledger id, the extra column JSON text or NULL when nothing is left over. A column that cannot
 * take those fails the batch, not the line.
 */
function checkProvenanceTypes(mapping: Mapping, table: TableInfo, report: ShapeReport): void {
  const chunkCol =
    mapping.chunkColumn === null ? undefined : table.columns.get(mapping.chunkColumn);

  if (
    chunkCol !== undefined &&
    baseOf(chunkCol) !== 'bigint' &&
    !stringTypes.has(baseOf(chunkCol))
  ) {
    report.problems.push(
      `${table.name}.${chunkCol.name}: chunkColumn must be BIGINT, BIGINT UNSIGNED ` +
        `or a text column, not ${chunkCol.dataType}`
    );
  }

  const extraCol =
    mapping.extraColumn === null ? undefined : table.columns.get(mapping.extraColumn);

  if (extraCol !== undefined) {
    if (baseOf(extraCol) !== 'json' && !stringTypes.has(baseOf(extraCol)))
      report.problems.push(
        `${table.name}.${extraCol.name}: extraColumn must be a JSON or text ` +
          `column, not ${extraCol.dataType}`
      );

    if (!extraCol.nullable)
      report.problems.push(
        `${table.name}.${extraCol.name}: extraColumn is NOT NULL, but a fully ` +
          'mapped document leaves it NULL; make it nullable'
      );
  }
}

/** Every NOT NULL column the load never writes must have a default, or the first INSERT fails. */
function checkUnmapped(table: TableInfo, written: Set<string>, report: ShapeReport): void {
  for (const live of table.columns.values()) {
    if (written.has(live.name) || live.nullable || live.hasDefault || live.autoIncrement) continue;

    report.problems.push(
      `${table.name}.${live.name} is NOT NULL without a default and no mapping entry writes it`
    );
  }
}

function checkParent(
  mapping: Mapping,
  table: TableInfo,
  options: ShapeOptions,
  report: ShapeReport
): void {
  const { key } = mapping;
  const written = new Set<string>([key.column, ...mapping.columns.map(c => c.column)]);

  for (const extra of [mapping.runIdColumn, mapping.chunkColumn, mapping.extraColumn])
    if (extra !== null) written.add(extra);

  const keyCol = table.columns.get(key.column);

  if (keyCol === undefined)
    report.problems.push(`${table.name}: key column ${key.column} is missing`);
  else {
    const isPk = table.primaryKey.length === 1 && table.primaryKey[0] === key.column;

    const ownUnique = table.uniqueKeys.find(
      u => u.columns.length === 1 && u.columns[0] === key.column
    );

    if (!isPk && ownUnique === undefined)
      report.problems.push(
        `${table.name}.${key.column}: the key needs a single-column PRIMARY KEY or UNIQUE KEY`
      );

    // A prefix index collides on the first N characters in MySQL but not in the loader, so every
    // batch would fail the race check.
    if ((isPk && table.primaryKeyPrefix) || ownUnique?.prefix === true) {
      report.problems.push(
        `${table.name}.${key.column}: the key needs a full-column UNIQUE key; ` +
          `${isPk ? 'PRIMARY' : ownUnique?.name} indexes only the first N characters`
      );
    }

    // Another unique key could make the upsert update a different row than the key says.
    const pkColumn =
      table.primaryKey.length === 1 ? table.columns.get(table.primaryKey[0] as string) : undefined;

    const surrogatePk =
      table.primaryKey.length === 1 &&
      !isPk &&
      pkColumn?.autoIncrement === true &&
      !written.has(pkColumn.name);

    if (!isPk && !surrogatePk && table.primaryKey.length > 0) {
      report.problems.push(
        `${table.name}: PRIMARY KEY (${table.primaryKey.join(', ')}) is neither ` +
          'the key column nor an unwritten AUTO_INCREMENT id'
      );
    }

    for (const u of table.uniqueKeys) {
      if (u === ownUnique) continue;

      report.problems.push(
        `${table.name}: UNIQUE KEY ${u.name} (${u.columns.join(', ')}) could match ` +
          'a row the key does not; only the key column may be unique'
      );
    }

    if (key.cast === 'string') {
      const problem = stringKeyProblem(table.name, key.column, keyCol);

      if (problem !== null) report.problems.push(problem);
    }

    if (key.cast === 'objectId') {
      const problem = familyProblem(table.name, key.column, 'objectId', keyCol);

      if (problem !== null) report.problems.push(problem);
    }

    // The key ledger stores `key_value` as VARCHAR(760); a longer key column could hold values it
    // cannot record.
    if (
      options.keyLedger &&
      keyCol.charLength !== null &&
      keyCol.charLength > keyLedgerKey.maxChars
    ) {
      report.problems.push(
        `${table.name}.${key.column}: ${keyCol.charLength} characters exceed the ` +
          `${keyLedgerKey.maxChars} the key ledger stores; shorten it or set ` +
          'load.keyLedger false'
      );
    }
  }

  checkMappedColumns(table, mapping.columns, options, report);

  for (const [what, name] of [
    ['runIdColumn', mapping.runIdColumn],
    ['chunkColumn', mapping.chunkColumn],
    ['extraColumn', mapping.extraColumn],
  ] as const) {
    if (name !== null && !table.columns.has(name))
      report.problems.push(`${table.name}: ${what} ${name} is missing`);
  }

  checkProvenanceTypes(mapping, table, report);

  const runIdCol =
    mapping.runIdColumn === null ? undefined : table.columns.get(mapping.runIdColumn);

  if (runIdCol !== undefined && options.loadRunId !== undefined) {
    // The run id is written into every row; a narrow column would fail every batch after the shape
    // check passed.
    if (!stringTypes.has(baseOf(runIdCol)))
      report.problems.push(
        `${table.name}.${runIdCol.name}: runIdColumn must be a CHAR, VARCHAR or ` +
          `TEXT column, not ${runIdCol.dataType}`
      );
    else if (runIdCol.charLength !== null && runIdCol.charLength < options.loadRunId.length) {
      report.problems.push(
        `${table.name}.${runIdCol.name}: ` +
          `${runIdCol.dataType}(${runIdCol.charLength}) is shorter than the run id ` +
          `${options.loadRunId} (${options.loadRunId.length} characters)`
      );
    }
  }

  if (
    mapping.chunkColumn !== null &&
    table.columns.has(mapping.chunkColumn) &&
    !table.indexedColumns.includes(mapping.chunkColumn)
  ) {
    report.warnings.push(
      `${table.name}.${mapping.chunkColumn} has no index; reconcile's per-chunk ` +
        'GROUP BY will scan the table'
    );
  }

  checkUnmapped(table, written, report);
}

function checkChild(
  mapping: Mapping,
  child: Mapping['children'][number],
  table: TableInfo,
  options: ShapeOptions,
  report: ShapeReport
): void {
  const written = new Set<string>([child.parentColumn, ...child.columns.map(c => c.column)]);

  if (child.indexColumn !== null) written.add(child.indexColumn);

  const parentCol = table.columns.get(child.parentColumn);

  if (parentCol === undefined)
    report.problems.push(`${table.name}: parentColumn ${child.parentColumn} is missing`);
  else {
    if (mapping.key.cast === 'string') {
      // The per-batch DELETE on parentColumn compares under its collation: a padding or
      // case-folding one would remove other parents' rows.
      const problem = stringKeyProblem(table.name, child.parentColumn, parentCol);

      if (problem !== null) report.problems.push(problem);
    }

    // Every batch runs DELETE ... WHERE parentColumn IN (...): unindexed, it scans the child table,
    // and concurrent scans deadlock.
    if (!table.indexedColumns.includes(child.parentColumn)) {
      const message =
        `${table.name}.${child.parentColumn} has no index; every batch's DELETE ` +
        'scans the table';

      if ((options.concurrency ?? 1) > 1)
        report.problems.push(
          `${message} and concurrent chunks deadlock on it; add an index or set load.concurrency 1`
        );
      else report.warnings.push(message);
    }
  }

  if (child.indexColumn !== null && !table.columns.has(child.indexColumn))
    report.problems.push(`${table.name}: indexColumn ${child.indexColumn} is missing`);

  checkMappedColumns(table, child.columns, options, report);
  checkUnmapped(table, written, report);
}

/**
 * Compares the mapping with the live tables. Problems stop the load; warnings print. A missing
 * table is reported as `missing table <name>: ...` and its CREATE statement lands in `ddl` (its
 * name in `created`), so a load with `--create-tables` can run that DDL and check again instead of
 * failing.
 */
export default function checkTableShape(
  mapping: Mapping,
  tables: ReadonlyMap<string, TableInfo | null>,
  options: ShapeOptions
): ShapeReport {
  const report: ShapeReport = { problems: [], warnings: [], ddl: [], created: [] };

  const expected = [
    { name: mapping.table, index: 0 },
    ...mapping.children.map((c, i) => ({ name: c.table, index: i + 1 })),
  ];

  const missing = expected.filter(t => (tables.get(t.name) ?? null) === null);

  if (missing.length > 0) {
    let statements: string[] = [];

    try {
      statements = mappingToDdl(mapping, { keyLedger: options.keyLedger });
    } catch (err) {
      report.problems.push(errorMessage(err));
    }

    for (const t of missing) {
      report.problems.push(
        `missing table ${t.name}: create it from the mapping's .sql or pass --create-tables`
      );

      const ddl = statements[t.index];

      if (ddl !== undefined) {
        report.ddl.push(ddl);
        report.created.push(t.name);
      }
    }
  }

  const parent = tables.get(mapping.table);

  if (parent) checkParent(mapping, parent, options, report);

  for (const child of mapping.children) {
    const table = tables.get(child.table);

    if (table) checkChild(mapping, child, table, options, report);
  }

  return report;
}
