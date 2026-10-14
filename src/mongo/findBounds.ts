import type { Collection, Document } from 'mongodb';

type Bounds = { field: string; hint: string } | { objectId: true };

/**
 * The value at a dotted path of a returned document; the server nests `meta.ts` as
 * `{ meta: { ts } }`.
 */
const valueAt = (doc: Document, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (v, k) =>
        typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined,
      doc
    );

/**
 * Lowest and highest value of a window field (or of the ObjectId ids), as two hinted sorted
 * `findOne`s. Type filters keep a stray string or null from becoming the minimum.
 */
export default async function findBounds(
  coll: Collection,
  bounds: Bounds,
  maxTimeMs: number
): Promise<{ min: unknown; max: unknown } | null> {
  const field = 'objectId' in bounds ? '_id' : bounds.field;

  const filter: Document =
    'objectId' in bounds ? { _id: { $type: 'objectId' } } : { [field]: { $type: 'date' } };

  const hint = 'objectId' in bounds ? '_id_' : bounds.hint;
  const projection: Document = { _id: 1, ...(field === '_id' ? {} : { [field]: 1 }) };

  const one = (direction: 1 | -1) =>
    coll.findOne(filter, { sort: { [field]: direction }, hint, projection, maxTimeMS: maxTimeMs });

  const [lo, hi] = await Promise.all([one(1), one(-1)]);

  if (lo === null || hi === null) return null;

  return { min: valueAt(lo, field), max: valueAt(hi, field) };
}
