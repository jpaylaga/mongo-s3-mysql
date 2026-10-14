import isObject from '../ejson/isObject.js';
import errorMessage from '../runtime/errorMessage.js';
import msmError from '../runtime/msmError.js';
import type { ColumnInfo, ColumnMapping, JsonObject, MsmError, TableInfo, TransformContext, TransformResult } from '../types.js';
import isMsmError from '../runtime/isMsmError.js';
import castValue from './castValue.js';
import clipBytes from './clipBytes.js';
import describeValue from './describeValue.js';
import omitPaths from './omitPaths.js';
import readPath from './readPath.js';
import textLimit from './textLimit.js';
import valueColumns from './valueColumns.js';

/** `_msm_load_rejects.reason` is VARCHAR(512). */
const maxReasonChars = 512;

/** A line reject travels as a `cast` error from the column loop to the catch below; nothing else throws it. */
const rejectLine = (reason: string): MsmError => msmError('cast', reason);

/**
 * One mapped column from one source value. A cast error ends the line or nulls the column per `onCastError`;
 * a null that the live column cannot hold (NOT NULL, no default) ends the line whatever `onCastError` says,
 * since the INSERT would fail for the whole batch otherwise.
 */
function columnValue(
  source: { present: boolean; value: unknown }, col: ColumnMapping, target: ColumnInfo | null,
  onCastError: 'reject' | 'null', label: string, tally: { castErrors: number },
): unknown {
  let value: unknown;
  if (!source.present || source.value === null) value = col.default ?? null;
  else {
    const spec = { cast: col.cast, ...(col.fsp === undefined ? {} : { fsp: col.fsp }),
      ...(col.timezone === undefined ? {} : { timezone: col.timezone }), ...(col.round === undefined ? {} : { round: col.round }) };
    const cast = castValue(source.value, spec, target);
    if (cast.ok) value = cast.value;
    else if (onCastError === 'reject') throw rejectLine(`${label}: ${cast.reason}`);
    else {
      tally.castErrors += 1;
      value = null;
    }
  }
  if (value === null && target !== null && !target.nullable) throw rejectLine(`${label}: null for NOT NULL column`);
  return value;
}

/** Child rows per child table, plus the child sources that were consumed (an array, or missing or null). */
function childRows(doc: JsonObject, key: string, tc: TransformContext, tally: { castErrors: number }): { children: Map<string, unknown[][]>; consumed: string[] } {
  const children = new Map<string, unknown[][]>();
  const consumed: string[] = [];
  for (const child of tc.mapping.children) {
    const rows: unknown[][] = [];
    const source = readPath(doc, child.source);
    const table: TableInfo | null = tc.children.get(child.table) ?? null;
    if (source.present && source.value !== null && !Array.isArray(source.value)) {
      // Schema drift: the array became an object or a scalar. Under `null` the value stays in the extra column.
      if (tc.mapping.onCastError === 'reject') throw rejectLine(`${child.source}: not an array: ${describeValue(source.value)}`);
      tally.castErrors += 1;
    } else {
      consumed.push(child.source);
      if (source.present && Array.isArray(source.value)) {
        source.value.forEach((element, i) => {
          const row: unknown[] = [key];
          if (child.indexColumn !== null) row.push(i);
          for (const col of child.columns) {
            // A scalar element has no fields: only "." columns see it, the rest are missing.
            const value = col.source === '.' ? { present: true, value: element } : isObject(element) ? readPath(element, col.source) : { present: false, value: undefined };
            row.push(columnValue(value, col, table?.columns.get(col.column) ?? null, tc.mapping.onCastError, `${child.table}.${col.column}[${i}]`, tally));
          }
          rows.push(row);
        });
      }
    }
    children.set(child.table, rows);
  }
  return { children, consumed };
}

/**
 * One archive line to one upsert row plus its child rows. `values` are filled column by column
 * in `valueColumns` order (key column, mapped columns in mapping order, then `runIdColumn`, `chunkColumn`,
 * `extraColumn` when set), the same list the INSERT names, so the order is defined once; child rows are
 * `[parent key, index (when indexColumn is set), ...columns]`. A line whose `_id` the key cast refuses is
 * rejected whatever `onCastError` says: without a key there is nothing to upsert on. A RangeError (a value
 * too deep or too large for V8) is a reject too, so one line can never fail its chunk.
 */
export default function transformLine(text: string, lineNo: number, tc: TransformContext): TransformResult {
  const reject = (reason: string): TransformResult => ({ kind: 'reject', lineNo, reason: reason.slice(0, maxReasonChars), text: clipBytes(text) });
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return reject(`invalid JSON: ${errorMessage(err)}`);
  }
  if (!isObject(doc)) return reject('not a JSON object');

  const { mapping, table } = tc;
  const keyCast = castValue(doc._id, { cast: `key-${mapping.key.cast}` }, table.columns.get(mapping.key.column) ?? null);
  if (!keyCast.ok) return reject(`_id: ${keyCast.reason}`);
  const key = keyCast.value as string;

  const tally = { castErrors: 0 };
  try {
    const mapped = new Map(mapping.columns.map((c) => [c.column, c]));
    // The child rows are built once, when the extra column (which omits the consumed child sources) or the result needs them.
    let kids: ReturnType<typeof childRows> | null = null;
    const childrenOf = () => (kids ??= childRows(doc, key, tc, tally));
    const extraValue = (column: string): unknown => {
      const rest = omitPaths(doc, ['_id', ...mapping.columns.map((c) => c.source), ...childrenOf().consumed]);
      if (Object.keys(rest).length === 0) return null;
      const json = JSON.stringify(rest);
      const extra = table.columns.get(column) ?? null;
      const limit = extra !== null && !extra.dataType.startsWith('json') ? textLimit(json, extra) : null;
      if (limit !== null) throw rejectLine(`${column}: ${limit}`);
      return json;
    };
    const provenance = new Map<string, (column: string) => unknown>();
    if (mapping.runIdColumn !== null) provenance.set(mapping.runIdColumn, () => tc.loadRunId);
    if (mapping.chunkColumn !== null) provenance.set(mapping.chunkColumn, () => tc.ledgerId);
    if (mapping.extraColumn !== null) provenance.set(mapping.extraColumn, extraValue);
    const values = valueColumns(mapping).map((column): unknown => {
      if (column === mapping.key.column) return key;
      const col = mapped.get(column);
      if (col !== undefined) return columnValue(readPath(doc, col.source), col, table.columns.get(column) ?? null, mapping.onCastError, column, tally);
      const fill = provenance.get(column);
      if (fill === undefined) throw msmError('config', `${column}: in the VALUES list but neither mapped nor a provenance column`, { fatal: true });
      return fill(column);
    });
    return { kind: 'row', key, values, children: childrenOf().children, castErrors: tally.castErrors };
  } catch (err) {
    if (isMsmError(err, 'cast')) return reject(err.message);
    if (err instanceof RangeError) return reject(`value too large or too deep: ${err.message}`);
    throw err;
  }
}
