import fitIdentifier from '../mysql/fitIdentifier.js';
import keyLedgerKey from '../mysql/keyLedgerKey.js';
import formatUtc from '../runtime/formatUtc.js';
import type { BuildMappingOptions, CastChoice, ChildMapping, ColumnMapping, Mapping, PathStats } from '../types.js';
import chooseCast from './chooseCast.js';
import identifier from './identifier.js';

/** VARCHAR sizes a string key may take: the largest is the key ledger's width and inside InnoDB's 3,072-byte utf8mb4 index limit. */
const keyMaxChars = keyLedgerKey.maxChars;
const keySizes = [32, 64, 128, 255, 512, keyMaxChars];

/** What a mapping `source` may hold for a top-level field: no `$`, no dot (a dot would read as nesting). */
const sourceRe = /^[^$.][^$.]*$/;

/** Case-insensitive uniqueness against earlier and reserved names: `_2`, `_3`, ... on a clash. */
function unique(name: string, taken: Set<string>): string {
  let candidate = fitIdentifier(name);
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = fitIdentifier(`${name}_${n}`);
  taken.add(candidate.toLowerCase());
  return candidate;
}

const singular = (name: string): string => (name.endsWith('s') && name.length > 1 ? name.slice(0, -1) : name);

/** InnoDB refuses a row definition above 65,535 bytes; the estimate below stops a little under it. */
const rowLimitBytes = 65_000;

/**
 * What one column adds to the row-size limit in a utf8mb4 table: VARCHAR(n) is 4n + 2, CHAR(n) 4n, the
 * fixed types their width, and TEXT, BLOB and JSON a 12-byte pointer (their data lives off the row).
 */
function columnBytes(sqlType: string | undefined, cast: string): number {
  const text = (sqlType ?? '').toUpperCase();
  const n = Number(/\((\d+)/.exec(text)?.[1] ?? 0);
  if (text.startsWith('VARCHAR')) return 4 * n + 2;
  if (text.startsWith('CHAR')) return 4 * n;
  if (text.startsWith('VARBINARY')) return n + 2;
  if (text.startsWith('BINARY')) return n;
  if (text.startsWith('DECIMAL')) {
    const scale = Number(/,(\d+)\)/.exec(text)?.[1] ?? 0);
    return 4 * Math.ceil((n - scale) / 9) + 4 * Math.ceil(scale / 9);
  }
  if (text.startsWith('TINYINT')) return 1;
  if (text.startsWith('INT')) return 4;
  if (text.startsWith('BIGINT') || text.startsWith('DOUBLE')) return 8;
  if (text.startsWith('DATETIME')) return 8;
  if (text.startsWith('TEXT') || text.startsWith('MEDIUMTEXT') || text.startsWith('JSON') || text.endsWith('BLOB')) return 12;
  return cast === 'string' ? 1022 : 8;
}

/**
 * MySQL sizes every utf8mb4 VARCHAR(n) at 4n + 2 bytes against a 65,535-byte row limit, so a collection with
 * many medium-length strings gets a CREATE TABLE the server refuses. While the estimate is over the limit,
 * the widest VARCHAR column (the last one on a tie) becomes TEXT, with a review line, so the DDL stays valid.
 */
function fitRowLimit(columns: ColumnMapping[], fixedBytes: number, review: string[], label: (column: string) => string): void {
  const total = () => fixedBytes + columns.reduce((sum, c) => sum + columnBytes(c.sqlType, c.cast), 0);
  while (total() > rowLimitBytes) {
    let widest: ColumnMapping | null = null;
    let width = 0;
    for (const c of columns) {
      const m = /^VARCHAR\((\d+)\)$/i.exec(c.sqlType ?? '');
      if (m !== null && Number(m[1]) >= width) { widest = c; width = Number(m[1]); }
    }
    if (widest === null) return;
    review.push(`${label(widest.column)}: VARCHAR(${width}) -> TEXT to stay under MySQL's 65,535-byte row limit`);
    widest.sqlType = 'TEXT';
  }
}

/** Keys in the order a reviewer reads them: where the value comes from, how it is cast, then the DDL hint and evidence. */
function column(name: string, source: string, choice: CastChoice, timezone: string): ColumnMapping {
  const col: ColumnMapping = { column: name, source, cast: choice.cast as ColumnMapping['cast'] };
  if (choice.cast === 'datetime') {
    col.fsp = 3;
    col.timezone = timezone;
  }
  if (choice.round !== undefined) col.round = choice.round;
  if (choice.sqlType !== null) col.sqlType = choice.sqlType;
  col.note = choice.note;
  return col;
}

/**
 * The key cast from the `_id` sample: the majority type among the three key casts wins and the rest is
 * reported, since those lines will be rejected. When no sampled `_id` fits any key cast (UUID binaries,
 * doubles), there is no mapping to write: null, and the caller reports the types it saw.
 */
function chooseKey(idStats: PathStats | undefined, sampled: number): { cast: Mapping['key']['cast']; sqlType: string; review: string | null } | null {
  const types = idStats?.types ?? {};
  const counts: { cast: Mapping['key']['cast']; count: number; label: string; sqlType: string }[] = [
    { cast: 'objectId', count: types.objectId ?? 0, label: 'ObjectId', sqlType: 'CHAR(24)' },
    { cast: 'string', count: types.string ?? 0, label: 'string', sqlType: idStats === undefined ? 'VARCHAR(255)' : stringKeyType(idStats) },
    { cast: 'bigint', count: (types.int ?? 0) + (types.long ?? 0), label: 'integer', sqlType: 'BIGINT' },
  ];
  const best = counts.reduce((a, b) => (b.count > a.count ? b : a));
  if (best.count === 0) return null;
  const others = sampled - best.count;
  const review = others > 0 && sampled > 0 ? `_id: ${others} non-${best.label} _id in the sample; such lines are rejected (key cast ${best.cast})` : null;
  return { cast: best.cast, sqlType: best.sqlType, review };
}

/** A string key gets its own sizing: a UNIQUE key cannot be TEXT, and over 760 characters neither the index nor the key ledger holds it. */
function stringKeyType(idStats: PathStats): string {
  const needed = Math.ceil(idStats.maxChars * 1.5);
  return `VARCHAR(${keySizes.find((size) => size >= needed) ?? keyMaxChars})`;
}

/**
 * The mapping file `infer` writes: one column per qualifying top-level field in first-seen
 * order, child tables for arrays of objects when asked, and a `review` list of every decision a person
 * should look at. The names follow the derivation table, so the DDL is valid without edits. `opts.table`
 * is used as given (an explicit `--table` is a MySQL identifier verbatim); the caller derives the default.
 */
export default function buildMapping(collection: string, stats: PathStats[], opts: BuildMappingOptions): Mapping | null {
  const table = fitIdentifier(opts.table);
  const review: string[] = [];
  const fate = opts.extraColumn === null ? 'dropped' : `left in ${opts.extraColumn}`;
  const taken = new Set(['id', opts.keyColumn, opts.runIdColumn, opts.chunkColumn, opts.extraColumn]
    .filter((n): n is string => n !== null).map((n) => n.toLowerCase()));
  const tables = new Set([table.toLowerCase()]);
  const columns: ColumnMapping[] = [];
  const children: ChildMapping[] = [];

  const idStats = stats.find((s) => s.path === '_id');
  const key = chooseKey(idStats, opts.sampled);
  if (key === null) return null;
  const keyType = key.sqlType;
  const keyCast = key.cast;

  const child = (field: string, elements: PathStats[]): ChildMapping | null => {
    // An element with no fields at all is rare, so the most frequent element field stands in for the element count.
    const elementCount = Math.max(0, ...elements.map((e) => e.present));
    const childTable = unique(`${table}_${identifier(field)}`, tables);
    const parentColumn = fitIdentifier(`${singular(table)}_${opts.keyColumn}`);
    const childTaken = new Set(['id', parentColumn.toLowerCase()]);
    const indexColumn = unique(`${singular(identifier(field))}_index`, childTaken);
    const childColumns: ColumnMapping[] = [];
    for (const e of elements) {
      if (!sourceRe.test(e.path)) {
        review.push(`${field}.${e.path}: not addressable as a source path; dropped`);
        continue;
      }
      if (childColumns.length >= opts.maxColumns) {
        review.push(`${field}.${e.path}: over maxColumns ${opts.maxColumns}; dropped`);
        continue;
      }
      const choice = chooseCast(e, { timezone: opts.timezone, sampled: elementCount, minPresence: opts.minPresence });
      if (choice.cast === null) {
        review.push(`${field}.${e.path}: ${choice.review}; dropped`);
        continue;
      }
      if (choice.review !== null) review.push(`${field}.${e.path}: ${choice.review}`);
      childColumns.push(column(unique(identifier(e.path), childTaken), e.path, choice, opts.timezone));
    }
    if (childColumns.length === 0) {
      tables.delete(childTable.toLowerCase());
      return null;
    }
    // The surrogate id, the parent key (as wide as the key column) and the index column come before the element fields.
    fitRowLimit(childColumns, 8 + columnBytes(keyType, keyCast) + 4, review, (c) => `${field}.${c}`);
    return { table: childTable, source: field, parentColumn, indexColumn, columns: childColumns };
  };

  for (const s of stats) {
    if (s.path === '_id') continue;
    if (!sourceRe.test(s.path)) {
      review.push(`${s.path}: not addressable as a source path -> ${fate}`);
      continue;
    }
    const choice = chooseCast(s, { timezone: opts.timezone, sampled: opts.sampled, minPresence: opts.minPresence });
    if (choice.cast === null) {
      review.push(`${s.path}: ${choice.review} -> ${fate}`);
      continue;
    }
    if (opts.childTables && s.arrayOfObjects && s.elements !== null) {
      const built = child(s.path, s.elements);
      if (built !== null) {
        children.push(built);
        continue;
      }
      review.push(`${s.path}: no element field qualified for a child table; kept as json`);
    }
    if (columns.length >= opts.maxColumns) {
      review.push(`${s.path}: over maxColumns ${opts.maxColumns} -> ${fate}`);
      continue;
    }
    if (choice.review !== null) review.push(`${s.path}: ${choice.review}`);
    columns.push(column(unique(identifier(s.path), taken), s.path, choice, opts.timezone));
  }

  // The surrogate id, the key column and the provenance columns (VARCHAR(64) run id, BIGINT chunk id, JSON extra) are fixed costs of the row.
  const provenance = (opts.runIdColumn === null ? 0 : 258) + (opts.chunkColumn === null ? 0 : 8) + (opts.extraColumn === null ? 0 : 12);
  fitRowLimit(columns, 8 + columnBytes(keyType, keyCast) + provenance, review, (c) => c);

  if (key.review !== null) review.push(key.review);
  if (key.cast === 'string' && idStats !== undefined && idStats.maxChars > keyMaxChars) {
    review.push(`_id: the longest sampled string _id has ${idStats.maxChars} characters; keys over ${keyMaxChars} cannot be indexed or recorded in the key ledger`);
  }

  return {
    collection, table,
    key: { column: opts.keyColumn, cast: key.cast, sqlType: key.sqlType },
    runIdColumn: opts.runIdColumn, chunkColumn: opts.chunkColumn, extraColumn: opts.extraColumn,
    onCastError: 'reject', columns, children,
    inferred: { at: formatUtc(opts.now, 'z'), tool: opts.toolVersion, sampled: opts.sampled, review },
  };
}
