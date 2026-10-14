import { MongoServerError } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import withRetry from '#runtime/withRetry';
import type { RunContext } from '#types';

/**
 * Some servers (DocumentDB) refuse a `$not $type` or `$or` count under an index hint; the message
 * names the hint.
 */
const hintRefused = (err: unknown): boolean =>
  err instanceof MongoServerError && /hint/i.test(err.message);

/**
 * `countDocuments` under `hint`, retried, falling back to an unhinted count when the server refuses
 * the hint. Returns the count and the hint it ran under (null after the fallback), which the chunk
 * manifest records. Counts come back as BSON Int32 or Long objects because the client does not
 * promote values.
 */
export default async function countDocs(
  ctx: RunContext,
  coll: Collection,
  filter: Document,
  hint: string | null,
  name: string
): Promise<{ count: number; hint: string | null }> {
  const maxTimeMS = ctx.config.mongo.maxTimeMs;

  const run = (h: string | null) =>
    withRetry(ctx, { source: 'mongo', name }, () =>
      coll.countDocuments(filter, { ...(h === null ? {} : { hint: h }), maxTimeMS })
    );

  try {
    return { count: Number(await run(hint)), hint };
  } catch (err) {
    if (hint === null || !hintRefused(err)) throw err;

    return { count: Number(await run(null)), hint: null };
  }
}
