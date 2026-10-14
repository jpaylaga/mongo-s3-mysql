import type { Collection, Document } from 'mongodb';
import msmError from '#runtime/msmError';
import type { ChunkPlan, RunContext } from '#types';

/**
 * One unsorted hinted cursor over a field window. No retry inside: a cursor that dies mid-window
 * cannot resume without a sort, so the error ends the attempt and the chunk restarts.
 */
export default async function* streamCursor(
  coll: Collection,
  plan: ChunkPlan,
  ctx: RunContext
): AsyncGenerator<Document> {
  const cursor = coll.find(plan.filter, {
    ...(plan.hint === null ? {} : { hint: plan.hint }),
    batchSize: ctx.config.mongo.batchSize,
    maxTimeMS: ctx.config.mongo.maxTimeMs,
  });

  try {
    for await (const doc of cursor) {
      if (ctx.signal.aborted) throw msmError('interrupted', `${plan.runId}: interrupted`);

      yield doc;
    }
  } finally {
    await cursor.close().catch(() => undefined);
  }
}
