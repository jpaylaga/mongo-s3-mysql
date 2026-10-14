import { ObjectId, type Db } from 'mongodb';
import findBounds from '../mongo/findBounds.js';
import formatCount from '../runtime/formatCount.js';
import formatUtc from '../runtime/formatUtc.js';
import withRetry from '../runtime/withRetry.js';
import type { CollectionInventory, RunContext } from '../types.js';
import suggestStrategy from './suggestStrategy.js';

/** `_bsontype` tags to `$type` names, the vocabulary the export's id brackets and the mapping casts use. */
const tagNames: Record<string, string> = {
  ObjectId: 'objectId', ObjectID: 'objectId', Int32: 'int', Double: 'double', Long: 'long', Decimal128: 'decimal',
  Binary: 'binData', Timestamp: 'timestamp', BSONRegExp: 'regex', BSONSymbol: 'symbol', Code: 'javascript',
  MinKey: 'minKey', MaxKey: 'maxKey', DBRef: 'object',
};

/** Promotion is off, so every number arrives as a BSON Int32, Long, Double or Decimal128 object with a `_bsontype`. */
function bsonType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  switch (typeof value) {
    case 'string': return 'string';
    case 'boolean': return 'bool';
    case 'object': {
      const tag = (value as { _bsontype?: unknown })._bsontype;
      return typeof tag === 'string' ? (tagNames[tag] ?? tag) : 'object';
    }
    default: return typeof value;
  }
}

/**
 * Reads only what a strategy needs: the estimated size, which fields lead an index, and the newest
 * `sampleSize` documents for `_id` types and top-level dates. Every driver call retries like the export's.
 */
export default async function inventoryCollection(ctx: RunContext, db: Db, name: string, sampleSize: number): Promise<CollectionInventory> {
  const { maxTimeMs, batchSize } = ctx.config.mongo;
  const coll = db.collection(name);
  const op = (what: string) => ({ source: 'mongo' as const, name: `${name} ${what}` });

  // The client does not promote values, so a count may arrive as a BSON Int32 or Long object.
  const estimatedCount = Number(await withRetry(ctx, op('estimatedDocumentCount'), () => coll.estimatedDocumentCount({ maxTimeMS: maxTimeMs })));
  const indexes = await withRetry(ctx, op('listIndexes'), () => coll.listIndexes().toArray());
  const sample = await withRetry(ctx, op('sample'), () =>
    coll.find({}, { sort: { _id: -1 }, limit: sampleSize, batchSize: Math.min(batchSize, sampleSize), maxTimeMS: maxTimeMs }).toArray());

  // Only the first key of an index serves a window filter, so that is the only one worth reporting.
  const indexedFields = [...new Set(indexes.map((ix) => Object.keys(ix.key)[0]).filter((k): k is string => typeof k === 'string'))];

  const idTypes: Record<string, number> = {};
  const dates = new Map<string, number>();
  for (const doc of sample) {
    const type = bsonType(doc._id);
    idTypes[type] = (idTypes[type] ?? 0) + 1;
    for (const [field, value] of Object.entries(doc)) {
      if (field !== '_id' && value instanceof Date) dates.set(field, (dates.get(field) ?? 0) + 1);
    }
  }
  const dateFields = [...dates]
    .map(([field, count]) => ({ field, ratio: count / sample.length, indexed: indexedFields.includes(field) }))
    .sort((a, b) => b.ratio - a.ratio || a.field.localeCompare(b.field));

  let objectIdTime: CollectionInventory['objectIdTime'] = null;
  if (idTypes.objectId) {
    const bounds = await withRetry(ctx, op('findBounds'), () => findBounds(coll, { objectId: true }, maxTimeMs));
    if (bounds && bounds.min instanceof ObjectId && bounds.max instanceof ObjectId) {
      objectIdTime = { min: formatUtc(bounds.min.getTimestamp(), 'z'), max: formatUtc(bounds.max.getTimestamp(), 'z') };
    }
  }

  const facts = { name, estimatedCount, indexedFields, idTypes, dateFields, objectIdTime };
  const suggestion = suggestStrategy(facts);
  const message = `${name}: about ${formatCount(estimatedCount)} documents, ${suggestion.strategy}${suggestion.field ? ` on ${suggestion.field}` : ''}`;
  ctx.emit({ type: 'info', command: ctx.command, message });
  if (suggestion.warn) ctx.emit({ type: 'warn', command: ctx.command, message: `${name}: ${suggestion.reason}` });
  return { ...facts, suggestion };
}
