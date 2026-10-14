import { ObjectId, type Collection, type Document } from 'mongodb';
import chunkRunId from '../layout/chunkRunId.js';
import countDocs from '../mongo/countDocs.js';
import findBounds from '../mongo/findBounds.js';
import idBrackets from '../mongo/idBrackets.js';
import objectIdAt from '../mongo/objectIdAt.js';
import durations from '../runtime/durations.js';
import floorTo from '../runtime/floorTo.js';
import formatCount from '../runtime/formatCount.js';
import formatUtc from '../runtime/formatUtc.js';
import msmError from '../runtime/msmError.js';
import withRetry from '../runtime/withRetry.js';
import type { BatchPlan, ChunkPlan, CollectionConfig, ExportSources, LiveGap, OutOfRange, PlannedCollection, RunContext, Window } from '../types.js';
import canonicalFilter from './canonicalFilter.js';
import restGapTerm from './restGapTerm.js';

const { hourMs, dayMs } = durations;

/**
 * More windows than this per collection is a sentinel date (0001-01-01, or the epoch with hour windows), not
 * history: day windows would plan hundreds of thousands of chunks and hour windows exhaust the heap before the prompt.
 */
const maxWindows = 100_000;

/** The UTC hour or day grid from `start` to `cutoff`, both ends clipped, so the first and last cells may be partial. */
function gridWindows(start: Date, cutoff: Date, size: 'hour' | 'day'): Window[] {
  const step = size === 'hour' ? hourMs : dayMs;
  const windows: Window[] = [];
  let at = start;
  while (at.getTime() < cutoff.getTime()) {
    const boundary = new Date(floorTo(at, step).getTime() + step);
    const end = boundary.getTime() < cutoff.getTime() ? boundary : cutoff;
    windows.push({ start: at, end });
    at = end;
  }
  return windows;
}

/**
 * The index whose first key is `field` in either direction; fewest keys, then name, so a plain index beats a
 * compound one. Sparse and partial indexes are skipped: hinted, they return incomplete results for the rest
 * filter (documents without the field), which would flag the rest chunk on every attempt. Hidden indexes are
 * skipped because the planner refuses a hint on one (BadValue, not retriable), which would abort the export.
 * Hashed and other special indexes are skipped too: they cannot bound a range, so hinted they scan the whole collection.
 */
async function pickIndex(coll: Collection, field: string): Promise<string> {
  const indexes = await coll.listIndexes().toArray();
  const leads = (ix: Document) => {
    if (typeof ix.name !== 'string' || ix.key === null || typeof ix.key !== 'object') return false;
    const key = ix.key as Document;
    // The client does not promote values, so the direction arrives as a BSON Int32 or Double; `hashed` and the other specials give NaN.
    const direction = Number(key[field]);
    return Object.keys(key)[0] === field && (direction === 1 || direction === -1);
  };
  const visible = (ix: Document) => ix.hidden !== true;
  const complete = (ix: Document) => ix.sparse !== true && ix.partialFilterExpression === undefined;
  const matching = indexes
    .filter((ix) => leads(ix) && visible(ix) && complete(ix))
    .map((ix) => ({ name: ix.name as string, keys: Object.keys(ix.key as Document).length }))
    .sort((a, b) => a.keys - b.keys || a.name.localeCompare(b.name));
  const best = matching[0];
  if (best === undefined) {
    const leading = indexes.filter(leads);
    if (leading.length > 0 && leading.every((ix) => !visible(ix))) {
      throw msmError('config', `${coll.collectionName}: only a hidden index starts with ${field}; unhide it or add one, timestamp-window needs a visible index`, { fatal: true });
    }
    const incomplete = leading.some((ix) => !complete(ix));
    throw msmError('config', `${coll.collectionName}: no ${incomplete ? 'complete (non-sparse, non-partial) ' : ''}ascending or descending index starts with ${field}; timestamp-window needs one`, { fatal: true });
  }
  return best.name;
}

/** `_id` values that are not ObjectIds: the 7 other brackets plus the types outside every bracket (null, MinKey, MaxKey, NaN, code, DBPointer). */
const nonObjectIdTerms = (): Document[] => [
  ...idBrackets.filter((b) => b.name !== 'objectId').map((b) => ({ _id: { $gte: b.lowest } })),
  { _id: { $type: ['null', 'minKey', 'maxKey', 'javascript', 'javascriptWithScope', 'dbPointer'] } },
  { _id: NaN },
];

interface Bounds { windowFilter(w: Window): Document; afterCutoff: Document; frozenGap: Document | null; liveGap: LiveGap; untyped: Document; beforeStart: Document | null; hint: string; field: string }

/**
 * Chunks for one collection of a batch: one manifest-only chunk for an empty collection,
 * else the grid windows (field or ObjectId time), a keyset walk for a full collection, and the rest
 * chunk that catches documents no window can see. Out-of-range counts are taken here so the plan
 * warnings come before the prompt; a resumed batch keeps the counts its manifest froze. `start` is the
 * first window's start the plan used, so a new batch can freeze it into its manifest.
 */
export default async function planChunks(ctx: RunContext, deps: ExportSources, batch: BatchPlan, cc: CollectionConfig): Promise<{ chunks: ChunkPlan[]; outOfRange: OutOfRange | null; start: Date | null }> {
  const planned: PlannedCollection | undefined = batch.collections.find((c) => c.collection === cc.name);
  if (planned === undefined) throw msmError('config', `${cc.name} is not in the plan of batch ${batch.batchId}`, { fatal: true });
  const { batchId } = batch;
  const name = cc.name;
  const coll = deps.mongo.db.collection(name);
  const maxTimeMs = ctx.config.mongo.maxTimeMs;
  const retry = <T>(what: string, fn: () => Promise<T>) => withRetry(ctx, { source: 'mongo', name: `${what} ${name}` }, fn);
  const count = async (filter: Document, hint: string | null) => (await countDocs(ctx, coll, filter, hint, `countDocuments ${name}`)).count;
  const warn = (message: string) => ctx.emit({ type: 'warn', command: ctx.command, message });
  const base = { collection: name };

  const any = await retry('findOne', () => coll.findOne({}, { projection: { _id: 1 }, maxTimeMS: maxTimeMs }));
  if (any === null) {
    const runId = chunkRunId(batchId, name, 'manifest-only', null);
    return {
      chunks: [{
        ...base, runId, mode: 'manifest-only', tail: 'full', filter: {},
        filterRecord: { mode: 'manifest-only', filter: 'no raw export; manifest and validation only' },
        hint: null, paging: 'none', brackets: [], rawPrefix: deps.layout.rawPrefix(name, null, runId),
      }],
      outOfRange: null, start: null,
    };
  }

  if (planned.mode === 'full-collection') {
    const runId = chunkRunId(batchId, name, 'full-collection', null, 'full');
    return {
      chunks: [{
        ...base, runId, mode: 'full-collection', tail: 'full', filter: {},
        filterRecord: { mode: 'full-collection', filter: 'all documents', hint: '_id_', query: {} },
        hint: '_id_', paging: 'keyset', brackets: idBrackets, rawPrefix: deps.layout.rawPrefix(name, null, runId),
      }],
      outOfRange: null, start: null,
    };
  }

  // Windowed: the bounds decide the first window; an explicit start (config, delta since, or a frozen plan) wins.
  const windowSize = planned.window ?? cc.window;
  const step = windowSize === 'hour' ? hourMs : dayMs;
  const explicitStart = planned.start_utc === null ? null : new Date(planned.start_utc);
  // The rest chunk must not see documents written while the batch runs (every insert is "after the cutoff"
  // on a live collection), so its after-cutoff term leaves a gap: [cutoff, startedAt) stays in (frozen), then
  // a day of live writes stays out, counted from each attempt's start (exportChunk rebuilds that term), then
  // far-future values are in again. Late arrivals land in the next delta.
  const frozenGap = <T>(at: (d: Date) => T, key: string): Document | null =>
    (batch.startedAt.getTime() > batch.cutoff.getTime() ? { [key]: { $gte: at(batch.cutoff), $lt: at(batch.startedAt) } } : null);
  let bounds: Bounds;
  let observedMin: Date | null = null;
  if (planned.mode === 'timestamp-window') {
    const field = planned.field ?? cc.field;
    if (field === undefined || field === null) throw msmError('config', `${name}: timestamp-window needs a field`, { fatal: true });
    const hint = await retry('listIndexes', () => pickIndex(coll, field));
    if (explicitStart === null) {
      const found = await retry('findBounds', () => findBounds(coll, { field, hint }, maxTimeMs));
      // A BSON date outside the JavaScript range (a Long.MIN_VALUE "since forever" sentinel) arrives as an Invalid Date, which no grid can start at.
      if (found !== null && found.min instanceof Date && Number.isNaN(found.min.getTime())) {
        throw msmError('config', `${name}: the oldest ${field} is outside the JavaScript date range (a sentinel); set collections[].start so older documents go to the rest chunk`, { fatal: true });
      }
      observedMin = found !== null && found.min instanceof Date ? found.min : null;
    }
    bounds = {
      field, hint,
      windowFilter: (w) => ({ [field]: { $gte: w.start, $lt: w.end } }),
      afterCutoff: { [field]: { $gte: batch.cutoff } },
      frozenGap: frozenGap((d) => d, field),
      liveGap: { key: field, kind: 'date', startedAt: batch.startedAt },
      untyped: { [field]: { $not: { $type: 'date' } } },
      beforeStart: explicitStart === null ? null : { [field]: { $lt: explicitStart } },
    };
  } else {
    if (explicitStart === null) {
      const found = await retry('findBounds', () => findBounds(coll, { objectId: true }, maxTimeMs));
      observedMin = found !== null && found.min instanceof ObjectId ? found.min.getTimestamp() : null;
    }
    bounds = {
      field: '_id', hint: '_id_',
      windowFilter: (w) => ({ _id: { $gte: objectIdAt(w.start), $lt: objectIdAt(w.end) } }),
      afterCutoff: { _id: { $gte: objectIdAt(batch.cutoff) } },
      frozenGap: frozenGap(objectIdAt, '_id'),
      liveGap: { key: '_id', kind: 'objectId', startedAt: batch.startedAt },
      untyped: { $or: nonObjectIdTerms() },
      beforeStart: explicitStart === null ? null : { _id: { $gte: new ObjectId('000000000000000000000000'), $lt: objectIdAt(explicitStart) } },
    };
  }

  const start = explicitStart ?? (observedMin === null ? null : floorTo(observedMin, step));
  if (start !== null) {
    const windowCount = Math.ceil((batch.cutoff.getTime() - start.getTime()) / step);
    if (windowCount > maxWindows) {
      throw msmError('config', `${name}: the oldest ${bounds.field} is ${formatUtc(start, 'z')}, which gives ${formatCount(windowCount)} ${windowSize} windows (more than ${formatCount(maxWindows)}); set collections[].start so older documents go to the rest chunk`, { fatal: true });
    }
  }
  // The epoch with day windows stays under the limit (about 20,000 chunks, nearly all empty), so it is named instead of refused.
  if (observedMin !== null && observedMin.getTime() === 0) {
    warn(`${name}: the oldest ${bounds.field} is exactly 1970-01-01T00:00:00Z (the epoch, a sentinel in most data); set collections[].start to the real start so older documents go to the rest chunk`);
  }
  const windows = start === null ? [] : gridWindows(start, batch.cutoff, windowSize);
  const chunks: ChunkPlan[] = windows.map((window) => {
    const runId = chunkRunId(batchId, name, planned.mode, window);
    const filter = bounds.windowFilter(window);
    return {
      ...base, runId, mode: planned.mode, tail: 'window', filter,
      filterRecord: {
        mode: planned.mode, field: bounds.field, start_utc: formatUtc(window.start, 'offset'), end_utc: formatUtc(window.end, 'offset'),
        boundary: '[start,end)', hint: bounds.hint, query: canonicalFilter(filter),
      },
      hint: bounds.hint, paging: planned.mode === 'objectid-window' ? 'keyset' : 'cursor',
      brackets: planned.mode === 'objectid-window' ? idBrackets.filter((b) => b.name === 'objectId') : [],
      rawPrefix: deps.layout.rawPrefix(name, window, runId),
    };
  });
  if (windows.length === 0) warn(`${name}: no window between ${start === null ? 'an unknown start' : formatUtc(start, 'z')} and the cutoff ${formatUtc(batch.cutoff, 'z')}`);

  // before_start only matters for a full batch with an explicit start: a delta leaves older documents out on purpose.
  const countBefore = batch.kind === 'full' && bounds.beforeStart !== null;
  const frozen = batch.resumed && Object.hasOwn(batch.outOfRange, name) ? batch.outOfRange[name] : undefined;
  const outOfRange: OutOfRange = frozen ?? {
    before_start: countBefore && bounds.beforeStart !== null ? await count(bounds.beforeStart, bounds.hint) : 0,
    after_cutoff: await count(bounds.afterCutoff, bounds.hint),
    untyped: await count(bounds.untyped, bounds.hint),
  };
  const untyped = outOfRange.untyped ?? 0;
  const restNote = planned.rest ? ' (the rest chunk exports them)' : '';
  if (outOfRange.before_start > 0 || outOfRange.after_cutoff > 0) {
    warn(`${name}: ${formatCount(outOfRange.before_start)} documents before the start and ${formatCount(outOfRange.after_cutoff)} at or after the cutoff are in no window${restNote}`);
  }
  if (untyped > 0) {
    const what = planned.mode === 'timestamp-window' ? `have no BSON date in ${bounds.field}` : 'have an _id that is not an ObjectId';
    warn(`${name}: ${formatCount(untyped)} documents ${what} and are in no window${restNote}`);
  }
  // Nothing in a window and no rest chunk would commit an empty plan over a non-empty collection as `complete`.
  if (start === null && !planned.rest) {
    const what = planned.mode === 'timestamp-window' ? `no document has a BSON date in ${bounds.field}; windows need a date field` : 'no document has an ObjectId _id; objectid-window needs one';
    throw msmError('config', `${name}: ${what} (or pass --include-rest to export the collection as the rest chunk)`, { fatal: true });
  }

  if (planned.rest) {
    const terms: Document[] = planned.mode === 'objectid-window' ? nonObjectIdTerms() : [bounds.untyped];
    if (bounds.frozenGap !== null) terms.push(bounds.frozenGap);
    if (countBefore && bounds.beforeStart !== null && outOfRange.before_start > 0) terms.push(bounds.beforeStart);
    // The live-gap term is last; exportChunk rebuilds it at each attempt's start (see restGapTerm).
    terms.push(restGapTerm(bounds.liveGap, batch.startedAt));
    const filter: Document = { $or: terms };
    const runId = chunkRunId(batchId, name, 'full-collection', null, 'rest');
    chunks.push({
      ...base, runId, mode: 'full-collection', tail: 'rest', filter,
      filterRecord: { mode: 'full-collection', filter: 'documents outside the windows', hint: bounds.hint, query: canonicalFilter(filter) },
      hint: bounds.hint, paging: 'keyset', brackets: idBrackets, rawPrefix: deps.layout.rawPrefix(name, null, runId),
      liveGap: bounds.liveGap,
    });
  }
  return { chunks, outOfRange, start };
}
