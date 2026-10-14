import type { Document } from 'mongodb';
import objectIdAt from '../mongo/objectIdAt.js';
import durations from '../runtime/durations.js';
import type { LiveGap } from '../types.js';

/**
 * The last `$or` term of a rest filter: window values from a day after `max(batch start, this attempt's
 * start)` on. Anchored on the attempt, not the batch, so a rest chunk run a day after the batch began (a
 * multi-day export, a next-day resume, a restart loop) still leaves the live writes out and can commit.
 */
export default function restGapTerm(gap: LiveGap, attemptStart: Date): Document {
  const from = new Date(Math.max(gap.startedAt.getTime(), attemptStart.getTime()) + durations.dayMs);
  const value = gap.kind === 'objectId' ? objectIdAt(from) : from;
  return { [gap.key]: { $gte: value } };
}
