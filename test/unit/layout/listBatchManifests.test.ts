import { describe, expect, it } from 'vitest';
import listBatchManifests from '../../../src/layout/listBatchManifests.js';
import { memoryContext, realShape } from '../../helpers.js';

describe('listBatchManifests', () => {
  it('returns batches ordered by cutoff_utc then run_id, ignoring chunk manifests and non-json keys', async () => {
    const { store, layout } = memoryContext();
    const full = await realShape('batch-full.json') as Record<string, unknown>;
    const delta = await realShape('batch-delta.json') as Record<string, unknown>;
    const put = (m: Record<string, unknown>) => store.putText(layout.batchManifest(m.run_id as string), JSON.stringify(m), 'application/json');
    await put(delta);
    await put({ ...full, run_id: 'zz-same-cutoff' });
    await put(full);
    await put({ ...full, run_id: 'aa-same-cutoff' });
    const chunk = await realShape('chunk-full-collection.json') as Record<string, unknown>;
    await store.putText(layout.chunkManifest('coupons', chunk.run_id as string), JSON.stringify(chunk), 'application/json');
    await store.putText(`${layout.batchesPrefix()}notes.txt`, 'x', 'text/plain');
    const batches = await listBatchManifests(store, layout);
    expect(batches.map((b) => b.batch.run_id)).toEqual(['aa-same-cutoff', full.run_id, 'zz-same-cutoff', delta.run_id]);
    expect(batches[0]?.key).toBe(layout.batchManifest('aa-same-cutoff'));
  });

  it('returns an empty list for an empty archive', async () => {
    const { store, layout } = memoryContext();
    expect(await listBatchManifests(store, layout)).toEqual([]);
  });
});
