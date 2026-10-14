import isObject from '#ejson/isObject';
import isWrapper from '#ejson/isWrapper';
import maxDecimalExponent from '#mapping/maxDecimalExponent';
import type { JsonObject, PathStats } from '#types';

const INT32_MAX = 2_147_483_647;

/**
 * The type name a value contributes to `PathStats.types`. Wrappers are read from the raw tree, so a
 * line that was written canonically and one written relaxed classify the same way as far as JSON
 * allows.
 */
function typeName(value: unknown): string {
  if (typeof value === 'string') return 'string';

  if (typeof value === 'boolean') return 'bool';

  if (typeof value === 'number')
    return Number.isInteger(value) ? (Math.abs(value) <= INT32_MAX ? 'int' : 'long') : 'double';

  if (Array.isArray(value)) return 'array';

  if (!isObject(value) || !isWrapper(value)) return 'object';

  const key = Object.keys(value)[0] as string;

  switch (key) {
    case '$oid':
      return 'objectId';
    case '$numberInt':
      return 'int';
    case '$numberLong':
      return 'long';
    case '$numberDouble':
      return 'double';
    case '$numberDecimal':
      return 'decimal';
    case '$date':
      return 'date';
    default:
      return key.slice(1);
  }
}

/** The numeric text behind a value, for digit counting; null when the value is not a number. */
function numericText(value: unknown, type: string): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;

  if (!isObject(value)) return null;

  const inner =
    value.$numberInt ?? value.$numberLong ?? value.$numberDouble ?? value.$numberDecimal;

  return typeof inner === 'string' && ['int', 'long', 'double', 'decimal'].includes(type)
    ? inner
    : null;
}

const numberText = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Integer digits and scale of a decimal literal, exponent applied, so `1.2E+3` counts as 1200 (4
 * integer digits, scale 0). Trailing fraction zeros count: `10.00` carries the scale the
 * application wrote.
 */
function digitsOf(text: string): { intDigits: number; scale: number } | null {
  const m = numberText.exec(text);

  if (m === null) return null;

  const intPart = m[1] ?? '';
  const fracPart = m[2] ?? '';

  if (intPart.length === 0 && fracPart.length === 0) return null;

  const exp = m[3] === undefined ? 0 : Number(m[3]);

  // A crafted exponent is not a value whose digits are worth counting (castValue refuses it the
  // same way).
  if (Math.abs(exp) > maxDecimalExponent) return null;

  const combined = intPart + fracPart;
  const point = intPart.length + exp;

  const integerPart = (point <= 0 ? '' : combined.slice(0, point).padEnd(point, '0')).replace(
    /^0+/,
    ''
  );

  return { intDigits: integerPart.length, scale: Math.max(0, combined.length - point) };
}

/**
 * Arrays of objects nested deeper than this are kept as json: a real MongoDB document cannot nest
 * past 100 levels, so anything deeper is a foreign or tampered line, and the recursion must not
 * follow it off the stack.
 */
const maxDepth = 32;

interface Accumulator {
  path: string;
  present: number;
  nulls: number;
  types: Record<string, number>;
  maxChars: number;
  maxBytes: number;
  maxIntDigits: number;
  maxScale: number;
  /** null until an array is seen; false once any value rules a child table out. */
  arrayOfObjects: boolean | null;
  /**
   * The element fields' own accumulators, fed as each element is seen, so no element is ever kept.
   */
  elements: Map<string, Accumulator> | null;
}

const newAccumulator = (path: string): Accumulator => ({
  path,
  present: 0,
  nulls: 0,
  types: {},
  maxChars: 0,
  maxBytes: 0,
  maxIntDigits: 0,
  maxScale: 0,
  arrayOfObjects: null,
  elements: null,
});

/**
 * Feeds one object's fields into the accumulators of `byPath`, creating them in first-seen order.
 */
function feed(byPath: Map<string, Accumulator>, doc: JsonObject, depth: number): void {
  for (const [key, value] of Object.entries(doc)) {
    let acc = byPath.get(key);

    if (acc === undefined) {
      acc = newAccumulator(key);
      byPath.set(key, acc);
    }

    observe(acc, value, depth);
  }
}

function observe(acc: Accumulator, value: unknown, depth: number): void {
  acc.present += 1;

  if (value === null) {
    acc.nulls += 1;

    return;
  }

  const type = typeName(value);

  acc.types[type] = (acc.types[type] ?? 0) + 1;

  if (typeof value === 'string') {
    acc.maxChars = Math.max(acc.maxChars, [...value].length);
    acc.maxBytes = Math.max(acc.maxBytes, Buffer.byteLength(value, 'utf8'));
  }

  const text = numericText(value, type);

  if (text !== null) {
    const digits = digitsOf(text);

    if (digits !== null) {
      acc.maxIntDigits = Math.max(acc.maxIntDigits, digits.intDigits);
      acc.maxScale = Math.max(acc.maxScale, digits.scale);
    }
  }

  if (acc.arrayOfObjects === false) return;

  if (!Array.isArray(value)) {
    acc.arrayOfObjects = false;
    acc.elements = null;

    return;
  }

  // An empty array is neutral: it neither proves nor rules out a child table.
  if (value.length === 0) return;

  if (depth < maxDepth && value.every(el => isObject(el) && !isWrapper(el))) {
    acc.arrayOfObjects = true;
    acc.elements ??= new Map();

    // Element fields are fed one element at a time: a document with hundreds of thousands of
    // subdocuments costs no extra memory.
    for (const el of value as JsonObject[]) feed(acc.elements, el, depth + 1);
  } else {
    acc.arrayOfObjects = false;
    acc.elements = null;
  }
}

const toStats = (byPath: Map<string, Accumulator>): PathStats[] =>
  [...byPath.values()].map(acc => ({
    path: acc.path,
    present: acc.present,
    nulls: acc.nulls,
    types: acc.types,
    maxChars: acc.maxChars,
    maxBytes: acc.maxBytes,
    maxIntDigits: acc.maxIntDigits,
    maxScale: acc.maxScale,
    arrayOfObjects: acc.arrayOfObjects === true,
    elements: acc.arrayOfObjects === true && acc.elements !== null ? toStats(acc.elements) : null,
  }));

/**
 * Per top-level field, in first-seen order: how often it is present or null, which types it holds,
 * and the sizes that decide column types. Arrays whose elements are all objects also get stats per
 * element field, which is what a child table is built from; the elements themselves are never kept.
 * `_id` is included so the key cast can be chosen.
 */
export default function collectPathStats(docs: JsonObject[]): PathStats[] {
  const byPath = new Map<string, Accumulator>();

  for (const doc of docs) feed(byPath, doc, 0);

  return toStats(byPath);
}
