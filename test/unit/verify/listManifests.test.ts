import { describe, expect, it } from 'vitest';
import toolVersion from '../../../src/runtime/toolVersion.js';
import listManifests from '../../../src/verify/listManifests.js';
import { memoryContext } from '../../helpers.js';
import seedArchive, { lines } from './seedArchive.js';

const B = 'app-archive-full-20261013T020304Z';

describe('listManifests', () => {
  it('lists the counted collections per batch, and turns a damaged manifest of a selected collection into a failing check', async () => {
    const { ctx, store, layout } = memoryContext({ command: 'verify', now: () => new Date('2026-10-13T03:00:00Z') });
    const seed = seedArchive(store, layout);
    const a = await seed.chunk({ collection: 'audit_log', batchId: B, lines: lines(2) });
    const o = await seed.chunk({ collection: 'orders', batchId: B, mode: 'objectid-window', lines: lines(2, 10) });
    const c = await seed.chunk({ collection: 'coupons', batchId: B, mode: 'manifest-only' });
    await store.putText(o.key, '{ broken', 'application/json');
    await store.putText(c.key, '{ broken', 'application/json');
    const result = await listManifests(ctx, store, layout, [{ id: B, batch: null }], ['audit_log', 'orders', 'coupons'], ['audit_log', 'orders']);
    expect(result.listed.get(B)?.map((r) => r.runId)).toEqual([a.runId]);
    // Only the selected collections' damage becomes a check; the unselected one still marks the batch as damaged.
    expect(result.invalid).toEqual([expect.objectContaining({ runId: o.runId, batchId: B, collection: 'orders', ok: false, lines: 0, errors: [expect.stringMatching(/^record: .*invalid JSON/)] })]);
    expect(result.invalid[0]?.counts).toBeUndefined();
    expect(result.invalid[0]?.parseCheck).toMatchObject({ mode: 'objectid-window', manifest_only: false, ok: false, verified_at: '2026-10-13T03:00:00+00:00', tool: toolVersion });
    expect([...result.damagedBatches]).toEqual([B]);
  });

  it('a batch with no manifest at all lists nothing and damages nothing', async () => {
    const { ctx, store, layout } = memoryContext({ command: 'verify' });
    const result = await listManifests(ctx, store, layout, [{ id: 'none', batch: null }], ['audit_log'], ['audit_log']);
    expect(result).toEqual({ listed: new Map([['none', []]]), invalid: [], damagedBatches: new Set() });
  });
});
