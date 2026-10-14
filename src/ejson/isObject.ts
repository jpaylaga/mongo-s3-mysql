/**
 * A plain JSON object: not null, not an array. The one definition every path reader and cast
 * shares.
 */
export default function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
