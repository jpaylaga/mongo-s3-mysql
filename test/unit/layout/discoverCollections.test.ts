import { describe, expect, it } from 'vitest';
import discoverCollections from '#layout/discoverCollections';
import { memoryContext } from '../../helpers.js';

describe('discoverCollections', () => {
  it('lists collection= common prefixes under the manifests area, sorted', async () => {
    const { store, layout } = memoryContext();

    await store.putText(
      layout.chunkManifest('orders', 'b-orders-full-collection-full'),
      '{}',
      'application/json'
    );

    await store.putText(
      layout.chunkManifest('audit_log', 'b-audit_log-full-collection-full'),
      '{}',
      'application/json'
    );

    await store.putText(
      layout.chunkManifest('audit_log', 'c-audit_log-full-collection-full'),
      '{}',
      'application/json'
    );

    await store.putText(layout.batchManifest('b'), '{}', 'application/json');

    await store.putText(
      `${layout.collectionsPrefix()}other=thing/x.json`,
      '{}',
      'application/json'
    );

    await store.putText(`${layout.counts('coupons', 'r')}`, '{}', 'application/json');
    expect(await discoverCollections(store, layout)).toEqual(['audit_log', 'orders']);
  });

  it('returns nothing for an empty archive', async () => {
    const { store, layout } = memoryContext();

    expect(await discoverCollections(store, layout)).toEqual([]);
  });
});
