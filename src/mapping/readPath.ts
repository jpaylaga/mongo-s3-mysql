import isObject from '#ejson/isObject';
import isWrapper from '#ejson/isWrapper';

/**
 * Resolves a mapping source path against a parsed line. `present` distinguishes a missing field
 * from an explicit null, which matters for `default`. Numeric segments index arrays; objects are
 * read by key only; an Extended JSON wrapper is a leaf.
 */
export default function readPath(doc: unknown, path: string): { present: boolean; value: unknown } {
  if (path === '.') return { present: true, value: doc };

  let current: unknown = doc;

  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { present: false, value: undefined };

      const index = Number(segment);

      if (index >= current.length) return { present: false, value: undefined };

      current = current[index];

      continue;
    }

    if (!isObject(current) || isWrapper(current) || !Object.hasOwn(current, segment))
      return { present: false, value: undefined };

    current = current[segment];
  }

  return { present: true, value: current };
}
