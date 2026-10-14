import type { Collection, Document } from 'mongodb';
import msmError from '../runtime/msmError.js';
import withRetry from '../runtime/withRetry.js';
import type { ChunkPlan, RunContext } from '../types.js';

const isEmpty = (filter: Document) => Object.keys(filter).length === 0;

const integerLike = /^(0|[1-9]\d*)$/;

/**
 * JavaScript moves integer-like keys to the front of an object, at any depth, so an embedded-document `_id`
 * with such a key re-serializes as a different BSON value: `$gt: last` would then re-read documents and flag
 * the chunk on every attempt. Such ids are refused with a clear error instead (docs/limitations.md). BSON
 * wrappers (`_bsontype`) keep their own layout and are not walked; arrays are walked for nested documents.
 */
function reorderedKeys(id: unknown): boolean {
  if (typeof id !== 'object' || id === null) return false;
  if (Array.isArray(id)) return id.some(reorderedKeys);
  if ((id as { _bsontype?: unknown })._bsontype !== undefined || ArrayBuffer.isView(id)) return false;
  return Object.entries(id as Record<string, unknown>).some(([k, v]) => integerLike.test(k) || reorderedKeys(v));
}

/**
 * Keyset pages over `_id` per bracket, always hinted `_id_`. Each page is its own retry scope that re-reads
 * from `last`, so a failover costs one page, not the chunk. The plan's filter (a window, or a rest chunk's
 * `$or`) is ANDed into every page; a short page ends the bracket.
 */
export default async function* streamKeyset(coll: Collection, plan: ChunkPlan, ctx: RunContext): AsyncGenerator<Document> {
  const limit = ctx.config.export.keysetPageDocs;
  const maxTimeMS = ctx.config.mongo.maxTimeMs;
  for (const bracket of plan.brackets) {
    let last: unknown = undefined;
    let first = true;
    for (;;) {
      if (ctx.signal.aborted) throw msmError('interrupted', `${plan.runId}: interrupted`);
      const range: Document = first ? { _id: { $gte: bracket.lowest } } : { _id: { $gt: last } };
      const query: Document = isEmpty(plan.filter) ? range : { $and: [plan.filter, range] };
      const page = await withRetry(ctx, { source: 'mongo', name: `keyset page ${plan.runId} ${bracket.name}` }, () =>
        coll.find(query).sort({ _id: 1 }).hint('_id_').limit(limit).maxTimeMS(maxTimeMS).toArray());
      for (const doc of page) {
        if (ctx.signal.aborted) throw msmError('interrupted', `${plan.runId}: interrupted`);
        if (reorderedKeys(doc._id)) {
          throw msmError('parse', `${plan.runId}: an embedded-document _id has an integer-like key (at some depth), which JavaScript reorders; such ids cannot be paged exactly (see docs/limitations.md)`);
        }
        yield doc;
      }
      if (page.length < limit) break;
      last = page[page.length - 1]?._id;
      first = false;
    }
  }
}
