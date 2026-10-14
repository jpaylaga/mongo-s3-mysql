import isObject from '../ejson/isObject.js';
import isWrapper from '../ejson/isWrapper.js';
import type { JsonObject } from '../types.js';

/** Removes `segments` below `value`; returns the input itself when nothing below it changes. */
function omit(value: unknown, segments: string[]): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (Array.isArray(value)) {
    if (!/^\d+$/.test(head) || Number(head) >= value.length) return value;
    const index = Number(head);
    if (rest.length === 0) return [...value.slice(0, index), ...value.slice(index + 1)];
    const child = omit(value[index], rest);
    if (child === value[index]) return value;
    const copy = [...value];
    copy[index] = child;
    return copy;
  }
  if (!isObject(value) || isWrapper(value) || !Object.hasOwn(value, head)) return value;
  if (rest.length === 0) {
    const { [head]: _removed, ...copy } = value;
    return copy;
  }
  const child = omit(value[head], rest);
  if (child === value[head]) return value;
  return { ...value, [head]: child };
}

const numeric = /^\d+$/;

/**
 * Removals are applied against the document as it was when every path was resolved: for one array, a higher
 * index is removed before a lower one, so an earlier splice never shifts a later target. Segment by segment,
 * numeric segments sort descending and the rest by name.
 */
function removalOrder(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x === y) continue;
    if (numeric.test(x) && numeric.test(y)) return Number(y) - Number(x);
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * The document minus every consumed path, for the extra column. Copy-on-write: only objects on a removed
 * path are copied, so the untouched bulk of a large document is shared with the parsed line.
 */
export default function omitPaths(doc: JsonObject, paths: readonly string[]): JsonObject {
  const ordered = paths.filter((p) => p !== '.').map((p) => p.split('.')).sort(removalOrder);
  let out: unknown = doc;
  for (const segments of ordered) out = omit(out, segments);
  return out as JsonObject;
}
