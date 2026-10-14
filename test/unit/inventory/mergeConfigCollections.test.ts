import { describe, expect, it } from 'vitest';
import mergeConfigCollections from '../../../src/inventory/mergeConfigCollections.js';
import type { InventoryReport } from '../../../src/types.js';

const report = (collections: InventoryReport['collections']): InventoryReport => ({ collections, skipped: [], exitCode: 0 });
const inventoried = (name: string, suggestion: InventoryReport['collections'][number]['suggestion']): InventoryReport['collections'][number] =>
  ({ name, estimatedCount: 1, indexedFields: [], idTypes: {}, dateFields: [], objectIdTime: null, suggestion });

describe('mergeConfigCollections', () => {
  it('replaces the list with the suggestions and keeps start, rest and mapping of a collection that keeps its name', () => {
    const raw = {
      mongo: { database: 'app' }, s3: { bucket: 'example-archive-bucket' },
      collections: [
        { name: 'audit_log', strategy: 'full-collection', start: '2026-01-01T00:00:00Z', rest: 'export', mapping: 'x.json' },
        { name: 'gone', strategy: 'full-collection', rest: 'skip' },
      ],
    };
    const next = mergeConfigCollections(raw, report([
      inventoried('audit_log', { name: 'audit_log', strategy: 'timestamp-window', field: 'created_at', window: 'day', rest: 'auto', reason: 'r', warn: false }),
      inventoried('coupons', { name: 'coupons', strategy: 'full-collection', window: 'day', rest: 'auto', reason: 'r', warn: false }),
    ]));
    expect(next.mongo).toEqual(raw.mongo);
    expect(next.collections).toEqual([
      { name: 'audit_log', strategy: 'timestamp-window', field: 'created_at', window: 'day', start: '2026-01-01T00:00:00Z', rest: 'export', mapping: 'x.json' },
      { name: 'coupons', strategy: 'full-collection' },
    ]);
    expect(raw.collections).toHaveLength(2);
  });

  it('tolerates a file whose collections entry is missing or not a list', () => {
    const next = mergeConfigCollections({ collections: 'nope' }, report([inventoried('a', { name: 'a', strategy: 'objectid-window', window: 'hour', rest: 'auto', reason: 'r', warn: false })]));
    expect(next.collections).toEqual([{ name: 'a', strategy: 'objectid-window', window: 'hour' }]);
  });
});
