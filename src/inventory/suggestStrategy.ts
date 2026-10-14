import durations from '../runtime/durations.js';
import formatCount from '../runtime/formatCount.js';
import smallCollectionDocs from '../runtime/smallCollectionDocs.js';
import type { CollectionConfig, InventoryFacts } from '../types.js';
/** Above this many documents a day, a day window would exceed a comfortable single-chunk restart. */
const busyPerDay = 2_000_000;
/** A window field must be a date in nearly every document, or the rest chunk carries the remainder. */
const dateRatio = 0.99;
const restNote = 'rest: auto skips the rest chunk; set rest: export or pass --include-rest';

const pct = (ratio: number) => `${(ratio * 100).toFixed(ratio >= 0.999 ? 1 : 0)}%`;

/** Creation timestamps make the best windows: they never move, so deltas and re-exports see the same documents. */
function pickDateField(inv: InventoryFacts): { field: string; ratio: number } | null {
  const candidates = inv.dateFields.filter((f) => f.indexed && f.ratio >= dateRatio);
  const first = (test: (field: string) => boolean) => candidates.find((f) => test(f.field));
  return first((f) => /^created/i.test(f)) ?? first((f) => /_at$|At$/.test(f)) ?? candidates[0] ?? null;
}

/** Documents per day over the ObjectId time span; a span under a day counts as one day. */
function docsPerDay(inv: InventoryFacts): number | null {
  if (!inv.objectIdTime) return null;
  const spanMs = Date.parse(inv.objectIdTime.max) - Date.parse(inv.objectIdTime.min);
  if (Number.isNaN(spanMs)) return null;
  return inv.estimatedCount / Math.max(1, spanMs / durations.dayMs);
}

/**
 * First match: small collections (at most `smallCollectionDocs`, below which a single keyset walk is cheap enough that windows only add chunks) go whole; ObjectId ids window on their embedded time; an
 * indexed date field windows on itself; anything else goes whole with `warn` set, so the caller prints the
 * reason as a warning without restating the threshold.
 */
export default function suggestStrategy(inv: InventoryFacts): CollectionConfig & { reason: string; warn: boolean } {
  const base = { name: inv.name, window: 'day' as const, rest: 'auto' as const, warn: false };
  if (inv.estimatedCount <= smallCollectionDocs) {
    return { ...base, strategy: 'full-collection', reason: `about ${formatCount(Math.round(inv.estimatedCount))} documents, one keyset chunk` };
  }
  const sampled = Object.values(inv.idTypes).reduce((a, b) => a + b, 0);
  if (sampled > 0 && inv.idTypes.objectId === sampled) {
    const perDay = docsPerDay(inv);
    const window = perDay !== null && perDay > busyPerDay ? 'hour' : 'day';
    const rate = perDay === null ? '' : `, about ${formatCount(Math.round(perDay))} documents per day`;
    return { ...base, strategy: 'objectid-window', window, reason: `every sampled _id is an ObjectId${rate}; ${restNote}` };
  }
  const date = pickDateField(inv);
  if (date) {
    return { ...base, strategy: 'timestamp-window', field: date.field, reason: `indexed ${date.field} is a date in ${pct(date.ratio)} of samples; ${restNote}` };
  }
  return { ...base, strategy: 'full-collection', reason: 'large collection, one keyset chunk', warn: true };
}
