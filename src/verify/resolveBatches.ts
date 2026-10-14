import listBatchManifests from '../layout/listBatchManifests.js';
import readRecord from '../layout/readRecord.js';
import recordSchemas from '../layout/recordSchemas.js';
import isMsmError from '../runtime/isMsmError.js';
import mapLimit from '../runtime/mapLimit.js';
import type { BatchManifest, Layout, ObjectStore, RunContext } from '../types.js';
import recordError from './recordError.js';

export interface VerifyBatch { id: string; batch: BatchManifest | null }

/**
 * The batches a verify run covers: the requested ids (their manifests read, null when there is none) or every
 * batch manifest under the layout. A batch manifest that does not parse is reported once and returned in
 * `invalid` with a null record, so the run goes on and names it as damaged rather than missing.
 */
export default async function resolveBatches(ctx: RunContext, store: ObjectStore, layout: Layout, ids: string[] | undefined): Promise<{ batches: VerifyBatch[]; invalid: string[] }> {
  const invalid: string[] = [];
  const invalidBatch = (key: string, message: string) => {
    const id = key.slice(key.lastIndexOf('run_id=') + 'run_id='.length, -'.json'.length);
    ctx.emit({ type: 'warn', command: ctx.command, message: `batch ${id}: invalid batch manifest (${recordError(message)})` });
    invalid.push(id);
  };
  if (ids !== undefined && ids.length > 0) {
    const batches = await mapLimit(ids, 4, async (id): Promise<VerifyBatch> => {
      try {
        return { id, batch: (await readRecord(store, layout.batchManifest(id), recordSchemas.batchManifest))?.value ?? null };
      } catch (err) {
        if (!isMsmError(err, 'record')) throw err;
        invalidBatch(layout.batchManifest(id), err.message);
        return { id, batch: null };
      }
    });
    return { batches, invalid };
  }
  const listed = await listBatchManifests(store, layout, invalidBatch);
  return { batches: listed.map(({ batch }) => ({ id: batch.run_id, batch })), invalid };
}
