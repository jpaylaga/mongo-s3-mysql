import type { Pool } from 'mysql2/promise';
import type { ColumnInfo, TableInfo } from '../types.js';

interface ColumnRow {
  COLUMN_NAME: string; DATA_TYPE: string; COLUMN_TYPE: string; IS_NULLABLE: string; COLUMN_DEFAULT: string | null; EXTRA: string;
  COLLATION_NAME: string | null; CHARACTER_MAXIMUM_LENGTH: unknown; CHARACTER_OCTET_LENGTH: unknown;
  NUMERIC_PRECISION: unknown; NUMERIC_SCALE: unknown; DATETIME_PRECISION: unknown;
}
interface IndexRow { INDEX_NAME: string; NON_UNIQUE: unknown; SEQ_IN_INDEX: unknown; COLUMN_NAME: string; SUB_PART?: unknown }

/** information_schema numbers arrive as strings under `bigNumberStrings`; lengths never approach 2^53. */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** information_schema reports no collation for the binary string types; to every comparison here they are `binary`. */
const binaryTypes = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);

/** `enum('a','b')` or `set('x','y')` as its members, quotes unescaped (MySQL doubles a quote inside a member). */
function membersOf(columnType: string): string[] | null {
  const m = /^(enum|set)\((.*)\)$/is.exec(columnType.trim());
  if (m === null) return null;
  const members: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  for (let hit = re.exec(m[2] as string); hit !== null; hit = re.exec(m[2] as string)) members.push((hit[1] as string).replace(/''/g, "'"));
  return members;
}

function columnInfo(r: ColumnRow): ColumnInfo {
  const extra = r.EXTRA.toLowerCase();
  const base = r.DATA_TYPE.toLowerCase();
  // `dataType` is `<type>[ unsigned]` so castValue can pick the integer range without parsing COLUMN_TYPE.
  const dataType = /\bunsigned\b/i.test(r.COLUMN_TYPE) ? `${base} unsigned` : base;
  return {
    name: r.COLUMN_NAME,
    dataType,
    nullable: r.IS_NULLABLE === 'YES',
    // A generated column is never written, so for the shape check it behaves like one with a default.
    hasDefault: r.COLUMN_DEFAULT !== null || extra.includes('generated'),
    autoIncrement: extra.includes('auto_increment'),
    collation: r.COLLATION_NAME ?? (binaryTypes.has(base) ? 'binary' : null),
    charLength: num(r.CHARACTER_MAXIMUM_LENGTH),
    octetLength: num(r.CHARACTER_OCTET_LENGTH),
    precision: num(r.NUMERIC_PRECISION),
    scale: num(r.NUMERIC_SCALE),
    fsp: num(r.DATETIME_PRECISION),
    members: membersOf(r.COLUMN_TYPE),
  };
}

/** One table's live shape from information_schema, or null when it does not exist. */
export default async function readTableInfo(pool: Pool, database: string, name: string): Promise<TableInfo | null> {
  const [columnRows] = await pool.query(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLLATION_NAME,
            CHARACTER_MAXIMUM_LENGTH, CHARACTER_OCTET_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [database, name],
  );
  const columnList = columnRows as ColumnRow[];
  if (columnList.length === 0) return null;

  // SUB_PART is the prefix length of a prefix index: such a UNIQUE key cannot stand in for a full-column one.
  const [indexRows] = await pool.query(
    `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [database, name],
  );
  const byIndex = new Map<string, { unique: boolean; columns: string[]; prefix: boolean }>();
  for (const r of indexRows as IndexRow[]) {
    const entry = byIndex.get(r.INDEX_NAME) ?? { unique: Number(r.NON_UNIQUE) === 0, columns: [], prefix: false };
    entry.columns.push(r.COLUMN_NAME);
    if (r.SUB_PART !== null && r.SUB_PART !== undefined) entry.prefix = true;
    byIndex.set(r.INDEX_NAME, entry);
  }

  const columns = new Map<string, ColumnInfo>();
  for (const r of columnList) columns.set(r.COLUMN_NAME, columnInfo(r));
  const primary = byIndex.get('PRIMARY');
  const uniqueKeys = [...byIndex.entries()].filter(([n, ix]) => n !== 'PRIMARY' && ix.unique).map(([n, ix]) => ({ name: n, columns: ix.columns, prefix: ix.prefix }));
  const indexedColumns = [...new Set([...byIndex.values()].map((ix) => ix.columns[0]).filter((c): c is string => c !== undefined))];
  return { name, columns, uniqueKeys, primaryKey: primary?.columns ?? [], primaryKeyPrefix: primary?.prefix ?? false, indexedColumns };
}
