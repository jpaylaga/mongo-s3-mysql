import recordJson from '../layout/recordJson.js';
import type { ChunkCheck, Layout, ObjectStore } from '../types.js';

/** The validation records of the checks: counts.json when the check carries one, parse-check.json always. */
export default async function writeChecks(store: ObjectStore, layout: Layout, checks: ChunkCheck[]): Promise<void> {
  for (const check of checks) {
    if (check.counts !== undefined) await store.putText(layout.counts(check.collection, check.runId), recordJson(check.counts), 'application/json');
    await store.putText(layout.parseCheck(check.collection, check.runId), recordJson(check.parseCheck), 'application/json');
  }
}
