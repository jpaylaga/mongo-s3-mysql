import { describe, expect, it } from 'vitest';
import createExportLedger from '../../../src/export/createExportLedger.js';
import writeBatchManifest from '../../../src/export/writeBatchManifest.js';
import recordSchemas from '../../../src/layout/recordSchemas.js';
import type { BatchPlan, ExportDeps } from '../../../src/types.js';
import { memoryContext } from '../../helpers.js';
import { fakeMongo } from './fakeMongo.js';

const plan = (over: Partial<BatchPlan> = {}): BatchPlan => ({
  batchId: 'app-archive-delta-20261020T010000Z', kind: 'delta', cutoff: new Date('2026-10-20T00:00:00Z'), since: new Date('2026-10-12T23:00:00Z'),
  startedAt: new Date('2026-10-20T01:00:00Z'), includeRest: false, resumed: false,
  collections: [
    { collection: 'audit_log', mode: 'timestamp-window', field: 'created_at', window: 'day', start_utc: '2026-10-12T23:00:00Z', rest: false },
    { collection: 'orders', mode: 'objectid-window', field: null, window: 'day', start_utc: '2026-10-12T23:00:00Z', rest: false },
    { collection: 'coupons', mode: 'full-collection', field: null, window: null, start_utc: null, rest: false },
  ],
  outOfRange: { audit_log: { before_start: 0, after_cutoff: 2 } },
  ...over,
});

describe('writeBatchManifest', () => {
  it('writes the running manifest with the frozen plan and completed_at null', async () => {
    const { store, layout } = memoryContext();
    const deps: ExportDeps = { mongo: fakeMongo([]), store, layout, ledger: createExportLedger('/nowhere', 'x') };
    const batch = plan();
    await writeBatchManifest(deps, batch, 'running', { completed: 0, failed: 17, now: new Date('2026-10-20T01:00:00Z'), notes: 'written by mongo-s3-mysql' });
    const text = store.objects.get(layout.batchManifest(batch.batchId))?.toString('utf8');
    const record = JSON.parse(text ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({
      run_id: batch.batchId, account_id: '111122223333', region: 'us-east-1', cluster: 'example-cluster', database: 'app',
      cutoff_utc: '2026-10-20T00:00:00Z', backup_mode: 'delta-windowed-with-full-small-collections', requested_start_utc: '2026-10-12T23:00:00Z',
      collection_start_utc: { audit_log: '2026-10-12T23:00:00Z', orders: '2026-10-12T23:00:00Z' },
      completed_chunks: 0, failed_chunks: 17, completed_at: null, notes: 'written by mongo-s3-mysql', schema_version: 1, status: 'running',
      started_at: '2026-10-20T01:00:00+00:00', out_of_range: { audit_log: { before_start: 0, after_cutoff: 2 } },
      plan: { kind: 'delta', include_rest: false, collections: batch.collections },
    });
    expect(record.tool).toMatch(/^mongo-s3-mysql@/);
    expect(recordSchemas.batchManifest.safeParse(record).success).toBe(true);
  });

  it('rewrites the final manifest with the tally and no delta keys for a full batch', async () => {
    const { store, layout } = memoryContext();
    const deps: ExportDeps = { mongo: fakeMongo([]), store, layout, ledger: createExportLedger('/nowhere', 'x') };
    const batch = plan({ batchId: 'app-archive-full-20261013T020304Z', kind: 'full', since: null, outOfRange: {} });
    await writeBatchManifest(deps, batch, 'complete', { completed: 17, failed: 0, now: new Date('2026-10-13T02:11:00Z') });
    const record = JSON.parse(store.objects.get(layout.batchManifest(batch.batchId))?.toString('utf8') ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({ completed_chunks: 17, failed_chunks: 0, completed_at: '2026-10-13T02:11:00+00:00', status: 'complete' });
    expect(record).not.toHaveProperty('backup_mode');
    expect(record).not.toHaveProperty('requested_start_utc');
    expect(record).not.toHaveProperty('collection_start_utc');
    expect(record).not.toHaveProperty('notes');
  });
});
