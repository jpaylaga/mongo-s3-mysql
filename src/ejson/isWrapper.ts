/**
 * An Extended JSON wrapper ({"$oid": ...}, {"$date": ...}, {"$numberDecimal": ...}) is one scalar
 * to the mapping: paths never enter it, infer never splits it, and omitPaths never edits inside it.
 * Every key of such an object starts with `$`.
 */
export default function isWrapper(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);

  return keys.length > 0 && keys.every(k => k.startsWith('$'));
}
