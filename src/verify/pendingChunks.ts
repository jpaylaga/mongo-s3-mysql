import readRecord from '../layout/readRecord.js';
import recordSchemas from '../layout/recordSchemas.js';
import isMsmError from '../runtime/isMsmError.js';
import mapLimit from '../runtime/mapLimit.js';
import type { Layout, ObjectStore, ResolvedManifest } from '../types.js';

/** A parse-check written for this exact manifest body that passed means the chunk was already proven. */
async function alreadyVerified(store: ObjectStore, key: string, manifestSha256: string): Promise<boolean> {
  try {
    const record = await readRecord(store, key, recordSchemas.parseCheck);
    return record !== null && record.value.ok === true && record.value.manifest_sha256 === manifestSha256;
  } catch (err) {
    if (isMsmError(err, 'record')) return false; // an unreadable parse-check is rewritten by this run
    throw err;
  }
}

/** The chunks a run reads: every manifest with `all`, else the ones without a passing parse-check for their current body. */
export default async function pendingChunks(store: ObjectStore, layout: Layout, manifests: ResolvedManifest[], all: boolean): Promise<ResolvedManifest[]> {
  if (all) return manifests;
  const kept = await mapLimit(manifests, 16, async (r) => ((await alreadyVerified(store, layout.parseCheck(r.collection, r.runId), r.sha256)) ? null : r));
  return kept.filter((r): r is ResolvedManifest => r !== null);
}
