import isObject from '../ejson/isObject.js';
import type { CastResult, CastSpec, ColumnInfo } from '../types.js';
import describeValue from './describeValue.js';
import formatWallClock from './formatWallClock.js';
import maxDecimalExponent from './maxDecimalExponent.js';
import textLimit from './textLimit.js';

const ok = (value: unknown): CastResult => ({ ok: true, value });
const fail = (reason: string): CastResult => ({ ok: false, reason });

/** The payload of a single-key wrapper such as {"$numberLong": "5"}, or undefined when `value` is not that wrapper. */
function unwrap(value: unknown, name: string): unknown {
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === name ? value[name] : undefined;
}

/** The column's base type and signedness; `dataType` is `readTableInfo`'s `<type>[ unsigned]`. */
function typeOf(target: ColumnInfo | null): { base: string; unsigned: boolean } {
  if (target === null) return { base: '', unsigned: false };
  const [base = '', ...rest] = target.dataType.toLowerCase().split(' ');
  return { base, unsigned: rest.includes('unsigned') };
}

const intRanges: Record<string, [bigint, bigint, bigint]> = {
  // signed min, signed max, unsigned max
  tinyint: [-128n, 127n, 255n],
  smallint: [-32768n, 32767n, 65535n],
  mediumint: [-8388608n, 8388607n, 16777215n],
  int: [-2147483648n, 2147483647n, 4294967295n],
  integer: [-2147483648n, 2147483647n, 4294967295n],
  bigint: [-(2n ** 63n), 2n ** 63n - 1n, 2n ** 64n - 1n],
};

function checkIntRange(n: bigint, target: ColumnInfo | null): string | null {
  const { base, unsigned } = typeOf(target);
  const range = intRanges[base];
  if (range === undefined) return null;
  const [min, max, umax] = range;
  const lo = unsigned ? 0n : min;
  const hi = unsigned ? umax : max;
  return n < lo || n > hi ? `${n} is outside ${target?.dataType ?? base} (${lo}..${hi})` : null;
}

/**
 * A bare JSON integer past 2^53 was already rounded by JSON.parse, so two different source values can arrive
 * as one number: the line is rejected rather than merged into another document's row.
 */
const unsafeBare = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value);
const unsafeBareReason = 'bare integer beyond 2^53 in a relaxed line; precision already lost';

/** An integer from $numberInt, $numberLong or a bare integral JSON number. */
function readInteger(value: unknown): bigint | null {
  const wrapped = unwrap(value, '$numberInt') ?? unwrap(value, '$numberLong');
  if (typeof wrapped === 'string' && /^-?\d+$/.test(wrapped)) return BigInt(wrapped);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

/** The canonical `$numberDouble` payloads: a decimal literal, or the three non-finite names (which then fail as unstorable). */
const doubleText = /^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const shown = (text: string): string => (text.length > 40 ? `${text.slice(0, 40)}...` : text);

/** `Number()` would read '' and whitespace as 0 and accept hex, octal and binary literals, none of which a BSON double ever writes. */
function readDoubleText(text: string): number | null {
  if (doubleText.test(text)) return Number(text);
  if (text === 'NaN' || text === 'Infinity' || text === '-Infinity') return Number(text);
  return null;
}

/** The types information_schema gives a precision and a scale for: DECIMAL(p,s), and FLOAT(M,D) or DOUBLE(M,D) in older schemas. */
const scaledTypes = new Set(['decimal', 'numeric', 'float', 'double']);

/**
 * A column with (p,s) holds p - s integer digits after MySQL has rounded the value at s. An integer or double
 * beyond that fails the whole INSERT under strict mode; `null` for `d` means the value has more than 65 digits.
 */
function checkScaledRange(d: Decimal | null, target: ColumnInfo | null): string | null {
  const { base } = typeOf(target);
  if (target === null || !scaledTypes.has(base) || target.precision === null || target.scale === null) return null;
  const allowed = target.precision - target.scale;
  const shape = `${target.dataType}(${target.precision},${target.scale})`;
  if (d === null) return `more than ${maxDecimalDigits} integer digits exceed ${allowed} of ${shape}`;
  const rounded = d.frac.length > target.scale ? roundHalfUp(d, target.scale) : d;
  const intDigits = rounded.int === '0' ? 0 : rounded.int.length;
  return intDigits > allowed ? `${intDigits} integer digits exceed ${allowed} of ${shape}` : null;
}

/** FLT_MAX exactly: 3.4028235e38 is already beyond what a FLOAT column takes. */
const floatMax = 3.4028234663852886e38;

function checkFloatMax(n: number, target: ColumnInfo | null): string | null {
  return typeOf(target).base === 'float' && Math.abs(n) > floatMax ? `${n} is outside FLOAT (+/-${floatMax})` : null;
}

/** UNSIGNED on DECIMAL, FLOAT and DOUBLE refuses a negative value; the integer types are covered by their ranges. */
function checkUnsigned(negative: boolean, target: ColumnInfo | null): string | null {
  const { base, unsigned } = typeOf(target);
  return negative && unsigned && intRanges[base] === undefined ? `a negative value is outside ${target?.dataType ?? base}` : null;
}

const decimalOf = (n: bigint): Decimal => ({ negative: n < 0n, int: (n < 0n ? -n : n).toString(), frac: '' });

/** The column rules an integer must pass whatever cast produced it: INT ranges, UNSIGNED, (p,s) integer digits, FLOAT. */
function checkIntegerColumn(n: bigint, target: ColumnInfo | null): string | null {
  return checkIntRange(n, target) ?? checkUnsigned(n < 0n, target) ?? checkScaledRange(decimalOf(n), target) ?? checkFloatMax(Number(n), target);
}

function castInt(value: unknown, target: ColumnInfo | null): CastResult {
  if (unsafeBare(value)) return fail(unsafeBareReason);
  const n = readInteger(value);
  if (n === null) return fail(`not an integer: ${describeValue(value)}`);
  const range = checkIntegerColumn(n, target);
  if (range !== null) return fail(range);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) return fail(`${n} is beyond 2^53; use cast bigint`);
  return ok(Number(n));
}

function castBigint(value: unknown, target: ColumnInfo | null): CastResult {
  if (unsafeBare(value)) return fail(unsafeBareReason);
  const n = readInteger(value);
  if (n === null) return fail(`not an integer: ${describeValue(value)}`);
  const range = checkIntegerColumn(n, target);
  return range === null ? ok(n.toString()) : fail(range);
}

const safeLimit = 2n ** 53n;

/** Half away from zero, as MySQL rounds a double into an integer column (Math.round takes -2.5 to -2). */
const roundAway = (n: number): number => Math.sign(n) * Math.round(Math.abs(n));

/** A double into an integer column is rounded by MySQL, so the rounded value must be in range; the other rules follow the integer ones. */
function checkDoubleColumn(n: number, target: ColumnInfo | null): string | null {
  if (intRanges[typeOf(target).base] !== undefined) return checkIntRange(BigInt(roundAway(n)), target);
  return checkUnsigned(n < 0, target) ?? checkScaledRange(parseDecimal(String(n)), target) ?? checkFloatMax(n, target);
}

function castDouble(value: unknown, target: ColumnInfo | null): CastResult {
  const wrapped = unwrap(value, '$numberDouble');
  let n: number;
  if (typeof wrapped === 'string') {
    const read = readDoubleText(wrapped);
    if (read === null) return fail(`not a number: $numberDouble ${JSON.stringify(shown(wrapped))}`);
    n = read;
  } else if (typeof value === 'number') n = value;
  else {
    const i = readInteger(value);
    if (i === null) return fail(`not a number: ${describeValue(value)}`);
    if (i > safeLimit || i < -safeLimit) return fail(`${i} is beyond 2^53 and would lose precision as a double`);
    n = Number(i);
  }
  if (!Number.isFinite(n)) return fail(`${wrapped ?? n} cannot be stored in MySQL`);
  const range = checkDoubleColumn(n, target);
  return range === null ? ok(n) : fail(range);
}

interface Decimal { negative: boolean; int: string; frac: string }

const maxDecimalDigits = 65;

/** A decimal literal (sign, digits, optional fraction and exponent) as plain integer and fraction digit strings. */
function parseDecimal(text: string): Decimal | null {
  const m = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  const exp = Number(m[4] ?? '0');
  if (Math.abs(exp) > maxDecimalExponent) return null;
  let digits = `${m[2] ?? ''}${m[3] ?? ''}`;
  let point = (m[2] ?? '').length + exp; // digits before the decimal point
  // The integer digit count is bounded before any padding, so a large exponent never allocates a huge string.
  // It is measured from the first significant digit: a zero coefficient (`0E+100`) has no integer digits at all.
  const lead = (/^0*/.exec(digits) as RegExpExecArray)[0].length;
  const intLength = lead === digits.length ? 0 : Math.max(0, point - lead);
  if (intLength > maxDecimalDigits) return null;
  if (point < 0) { digits = `${'0'.repeat(-point)}${digits}`; point = 0; }
  if (point > digits.length) digits = digits.padEnd(point, '0');
  const int = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  const frac = digits.slice(point).replace(/0+$/, '');
  const negative = m[1] === '-' && (int !== '0' || frac !== '');
  return { negative, int, frac };
}

/** Rounds half away from zero at `scale` fraction digits, as MySQL does for DECIMAL. */
function roundHalfUp(d: Decimal, scale: number): Decimal {
  const kept = d.frac.slice(0, scale);
  const next = d.frac.charAt(scale);
  if (next < '5') return { ...d, frac: kept.replace(/0+$/, '') };
  const bumped = (BigInt(`${d.int}${kept.padEnd(scale, '0')}`) + 1n).toString().padStart(scale + 1, '0');
  const int = bumped.slice(0, bumped.length - scale) || '0';
  return { negative: d.negative, int, frac: bumped.slice(bumped.length - scale).replace(/0+$/, '') };
}

const plain = (d: Decimal): string => `${d.negative ? '-' : ''}${d.int}${d.frac === '' ? '' : `.${d.frac}`}`;

/** The signed integer MySQL makes of a decimal text going into an integer column: rounded half away from zero at scale 0. */
const toInteger = (d: Decimal): bigint => {
  const rounded = d.frac === '' ? d : roundHalfUp(d, 0);
  const n = BigInt(rounded.int);
  return rounded.negative ? -n : n;
};

/** The column rules a decimal value must pass: an integer column takes it rounded, the scaled and float types their own ranges. */
function checkDecimalColumn(d: Decimal, target: ColumnInfo | null): string | null {
  if (intRanges[typeOf(target).base] !== undefined) return checkIntRange(toInteger(d), target);
  return checkUnsigned(d.negative, target) ?? checkScaledRange(d, target) ?? checkFloatMax(Number(plain(d)), target);
}

function castDecimal(value: unknown, spec: CastSpec, target: ColumnInfo | null): CastResult {
  if (unsafeBare(value)) return fail(unsafeBareReason);
  let d: Decimal | null;
  const exact = unwrap(value, '$numberDecimal');
  const dbl = unwrap(value, '$numberDouble');
  if (typeof exact === 'string') {
    d = parseDecimal(exact);
    if (d === null) return fail(`${shown(exact)} cannot be stored in MySQL`);
  } else if (typeof dbl === 'string' || typeof value === 'number') {
    // A double's shortest round-trip string is the value the application saw; never go through binary again.
    const n = typeof dbl === 'string' ? readDoubleText(dbl) : (value as number);
    if (n === null) return fail(`not a number: $numberDouble ${JSON.stringify(shown(dbl as string))}`);
    if (!Number.isFinite(n)) return fail(`${dbl ?? n} cannot be stored in MySQL`);
    d = parseDecimal(String(n));
    if (d === null) return fail(`not a decimal: ${describeValue(value)}`);
  } else {
    const i = readInteger(value);
    if (i === null) return fail(`not a decimal: ${describeValue(value)}`);
    d = decimalOf(i);
  }
  if (d.int.length > maxDecimalDigits) return fail(`${d.int.length} integer digits exceed the ${maxDecimalDigits} MySQL DECIMAL can hold`);
  const { base } = typeOf(target);
  // A DECIMAL column refuses extra fraction digits unless the mapping asks for rounding; FLOAT and DOUBLE round them silently.
  if (target !== null && (base === 'decimal' || base === 'numeric') && target.scale !== null && target.precision !== null && d.frac.length > target.scale) {
    if (spec.round !== 'half-up') return fail(`${d.frac.length} fraction digits exceed scale ${target.scale} of ${target.dataType}(${target.precision},${target.scale})`);
    d = roundHalfUp(d, target.scale);
  }
  const range = checkDecimalColumn(d, target);
  return range === null ? ok(plain(d)) : fail(range);
}

/** ENUM takes one member, SET a comma-separated subset; the comparison is case-insensitive unless the collation is binary or case-sensitive (`_bin`, `_cs`). */
function memberLimit(text: string, target: ColumnInfo | null): string | null {
  if (target === null || target.members === null) return null;
  const { base } = typeOf(target);
  const collation = target.collation ?? '';
  const exact = collation === 'binary' || collation.endsWith('_bin') || collation.endsWith('_cs');
  const norm = (s: string) => (exact ? s : s.toLowerCase());
  const members = new Set(target.members.map(norm));
  const values = base === 'set' ? (text === '' ? [] : text.split(',')) : [text];
  const bad = values.find((v) => !members.has(norm(v)));
  if (bad === undefined) return null;
  return `${JSON.stringify(shown(bad))} is not a member of ${target.dataType}(${target.members.length} values)`;
}

function castString(value: unknown, target: ColumnInfo | null): CastResult {
  if (typeof value !== 'string') return fail(`not a string: ${describeValue(value)}`);
  const limit = textLimit(value, target) ?? memberLimit(value, target);
  return limit === null ? ok(value) : fail(limit);
}

/** TIMESTAMP's range with a day of margin each side, so any session time_zone keeps the literal inside it. */
const timestampMin = Date.UTC(1970, 0, 2, 0, 0, 0);
const timestampMax = Date.UTC(2038, 0, 18, 23, 59, 59);
/** JavaScript's Date range; beyond it `new Date(ms)` is invalid and Intl throws. */
const dateRange = 8.64e15;
/** MySQL's year range 1000..9999 on the UTC instant, with a 14 hour margin for any wall-clock zone. */
const zoneMargin = 14 * 3_600_000;
const yearMin = Date.UTC(1000, 0, 1) - zoneMargin;
const yearMax = Date.UTC(9999, 11, 31, 23, 59, 59, 999) + zoneMargin;

/**
 * A string `$date` must name its offset: Date.parse reads a bare `2017-03-16T09:35:07` or a free-form date in the
 * loader host's time zone, so the same archive would load as different instants on two hosts.
 */
const dateText = /^(\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function castDatetime(value: unknown, spec: CastSpec, target: ColumnInfo | null): CastResult {
  const inner = unwrap(value, '$date');
  let ms: number;
  if (typeof inner === 'string') {
    if (!dateText.test(inner)) return fail(`not a date: ${JSON.stringify(shown(inner))} is not an ISO 8601 instant with an offset`);
    ms = Date.parse(inner);
  }
  // BSON dates are integral milliseconds; a fraction (a foreign or damaged archive) would build an invalid literal.
  else if (typeof inner === 'number' && Number.isInteger(inner)) ms = inner;
  else if (typeof inner === 'number') return fail(`not a date: ${inner} is not an integer millisecond count`);
  else {
    const long = unwrap(inner, '$numberLong');
    if (typeof long !== 'string' || !/^-?\d+$/.test(long)) return fail(`not a date: ${describeValue(value)}`);
    ms = Number(long);
  }
  if (!Number.isFinite(ms)) return fail(`not a date: ${describeValue(value)}`);
  // Checked before any Date is built: a sentinel such as Long.MAX_VALUE must reject the line, not throw out of the chunk.
  if (Math.abs(ms) > dateRange) return fail(`${ms} ms is outside the JavaScript date range`);
  if (ms < yearMin || ms > yearMax) return fail(`year of ${new Date(ms).toISOString()} is outside 1000..9999`);
  if (typeOf(target).base === 'timestamp' && (ms < timestampMin || ms > timestampMax)) {
    return fail(`${new Date(ms).toISOString()} is outside the TIMESTAMP range 1970-01-02..2038-01-18`);
  }
  const text = formatWallClock(ms, spec.timezone ?? 'UTC', spec.fsp ?? 0);
  const year = Number(text.slice(0, 4));
  if (!(year >= 1000 && year <= 9999) || text.charAt(4) !== '-') return fail(`year of ${new Date(ms).toISOString()} is outside 1000..9999`);
  return ok(text);
}

function castObjectId(value: unknown): CastResult {
  const hex = unwrap(value, '$oid');
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{24}$/.test(hex)) return fail(`not an ObjectId: ${describeValue(value)}`);
  return ok(hex.toLowerCase());
}

/** JSON into a text column (common in older schemas) is bound by that column's length like any string; a JSON column has no limit. */
function castJson(value: unknown, target: ColumnInfo | null): CastResult {
  if (value === undefined) return fail('missing');
  const text = JSON.stringify(value);
  const limit = typeOf(target).base === 'json' ? null : textLimit(text, target);
  return limit === null ? ok(text) : fail(limit);
}

const textBases = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
const isNumericBase = (base: string): boolean => intRanges[base] !== undefined || scaledTypes.has(base);

/**
 * The whitespace MySQL skips around a number in text: any trailing whitespace, and before an integer column
 * only spaces and tabs (a leading newline is error 1366), while DECIMAL, FLOAT and DOUBLE skip any leading whitespace.
 */
function trimNumericText(text: string, integer: boolean): string {
  return text.replace(integer ? /^[ \t]+/ : /^[\t\n\v\f\r ]+/, '').replace(/[\t\n\v\f\r ]+$/, '');
}

/** A text going into a numeric column is converted by MySQL: it must be a whole decimal literal and the result must fit the column. */
function numericTextLimit(text: string, target: ColumnInfo): string | null {
  const d = parseDecimal(trimNumericText(text, intRanges[typeOf(target).base] !== undefined));
  if (d === null) return `${JSON.stringify(shown(text))} is not a number for ${target.dataType}`;
  return checkDecimalColumn(d, target);
}

/**
 * MySQL reads a number going into ENUM as the 1-based member index and into SET as a bit mask over the
 * members, whatever cast produced it; a quoted one (`bigint`, `decimal`) is matched against the members by
 * text first. Anything else, a date or an ObjectId text included, is error 1265.
 */
function memberIndexLimit(value: unknown, target: ColumnInfo): string | null {
  const members = target.members ?? [];
  const text = String(value);
  if (typeof value === 'string' && memberLimit(text, target) === null) return null;
  const n = typeof value === 'number' ? value : (/^-?\d+$/.test(text) ? Number(text) : NaN);
  const { base } = typeOf(target);
  if (base === 'enum' && Number.isInteger(n) && n >= 1 && n <= members.length) return null;
  if (base === 'set' && Number.isInteger(n) && n >= 0 && n < 2 ** members.length) return null;
  const reading = base === 'enum' ? 'the 1-based member index' : 'a bit mask over the members';
  return `${JSON.stringify(shown(text))} is not a member of ${target.dataType}(${members.length} values); MySQL reads a number into ${base.toUpperCase()} as ${reading}`;
}

/**
 * The cast produced a value of its own family; the live column may be of another. What MySQL would refuse
 * at the INSERT is refused here instead, so one line never fails its batch: any text-family column bounds
 * every value as text (an ObjectId into CHAR(12)), ENUM and SET take members or member indexes, a string or
 * JSON text into a numeric column must be a number that fits it, and a JSON column takes only valid JSON text.
 */
function familyLimit(spec: CastSpec, value: unknown, target: ColumnInfo | null): string | null {
  if (target === null || value === null) return null;
  const { base } = typeOf(target);
  const textCast = spec.cast === 'string' || spec.cast === 'key-string' || spec.cast === 'json';
  // castString already checked membership; a json text is bound by the members like any other text.
  if (base === 'enum' || base === 'set') return spec.cast === 'json' ? memberLimit(String(value), target) : (textCast ? null : memberIndexLimit(value, target));
  if (textBases.has(base)) return textCast ? null : textLimit(String(value), target);
  if (textCast) {
    const text = String(value);
    if (isNumericBase(base)) return numericTextLimit(text, target);
    if (base === 'json' && spec.cast !== 'json') {
      try {
        JSON.parse(text);
      } catch {
        return `${JSON.stringify(shown(text))} is not valid JSON for ${target.dataType}`;
      }
    }
    return null;
  }
  if (base === 'json' && (spec.cast === 'datetime' || spec.cast === 'objectId' || spec.cast === 'key-objectId')) return `${JSON.stringify(shown(String(value)))} is not valid JSON for ${target.dataType}`;
  return null;
}

/**
 * One raw JSON.parse value to one SQL parameter under a cast. The wrappers of canonical Extended JSON are
 * read directly; the live column (`target`) supplies the limits that would otherwise surface as a MySQL
 * error in the middle of a batch, including the ones of a column whose type is not the cast's own family.
 */
export default function castValue(value: unknown, spec: CastSpec, target: ColumnInfo | null): CastResult {
  let result: CastResult;
  switch (spec.cast) {
    case 'string': case 'key-string': result = castString(value, target); break;
    case 'int': result = castInt(value, target); break;
    case 'bigint': case 'key-bigint': result = castBigint(value, target); break;
    case 'double': result = castDouble(value, target); break;
    case 'decimal': result = castDecimal(value, spec, target); break;
    case 'bool': result = typeof value === 'boolean' ? ok(value ? 1 : 0) : fail(`not a boolean: ${describeValue(value)}`); break;
    case 'datetime': result = castDatetime(value, spec, target); break;
    case 'objectId': case 'key-objectId': result = castObjectId(value); break;
    case 'json': result = castJson(value, target); break;
    default: return fail(`unknown cast ${String(spec.cast)}`);
  }
  if (!result.ok) return result;
  const limit = familyLimit(spec, result.value, target);
  if (limit !== null) return fail(limit);
  // mysql2 writes a number unquoted, and a JSON column refuses an unquoted number (error 3140); its text is the same JSON value.
  return typeof result.value === 'number' && typeOf(target).base === 'json' ? ok(String(result.value)) : result;
}
