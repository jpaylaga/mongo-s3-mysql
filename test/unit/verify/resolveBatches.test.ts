import { describe, expect, it } from 'vitest';
import resolveBatches from '../../../src/verify/resolveBatches.js';
import { memoryContext } from '../../helpers.js';
import seedArchive from './seedArchive.js';

describe('resolveBatches', () => {
  it('lists every batch manifest when no id is given, oldest cutoff first, and reports the ones that do not parse', async () => {
    const { ctx, store, layout, events } = memoryContext({ command: 'verify' });
    const seed = seedArchive(store, layout);
    await seed.batch('b-new', 1, { cutoff_utc: '2026-10-14T01:00:00Z' });
    await seed.batch('b-old', 1, { cutoff_utc: '2026-10-13T01:00:00Z' });
    await store.putText(layout.batchManifest('b-bad'), '{ "run_id": "x"', 'application/json');
    const { batches, invalid } = await resolveBatches(ctx, store, layout, undefined);
    expect(batches.map((b) => b.id)).toEqual(['b-old', 'b-new']);
    expect(batches.every((b) => b.batch !== null)).toBe(true);
    expect(invalid).toEqual(['b-bad']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'warn', message: expect.stringMatching(/^batch b-bad: invalid batch manifest \(record: .*invalid JSON\)$/) }));
  });

  it('reads the requested ids, null for a batch without a manifest, and a damaged one is invalid rather than thrown', async () => {
    const { ctx, store, layout } = memoryContext({ command: 'verify' });
    const seed = seedArchive(store, layout);
    await seed.batch('b1', 2);
    await store.putText(layout.batchManifest('b-bad'), '{ "run_id": "x"', 'application/json');
    const { batches, invalid } = await resolveBatches(ctx, store, layout, ['b1', 'none', 'b-bad']);
    expect(batches.map((b) => [b.id, b.batch?.completed_chunks ?? null])).toEqual([['b1', 2], ['none', null], ['b-bad', null]]);
    expect(invalid).toEqual(['b-bad']);
    // A read failure that is not a record error propagates.
    store.getText = async () => { throw Object.assign(new Error('boom'), { name: 'InternalError', $metadata: { httpStatusCode: 500 } }); };
    await expect(resolveBatches(ctx, store, layout, ['b1'])).rejects.toMatchObject({ name: 'InternalError' });
  });
});
