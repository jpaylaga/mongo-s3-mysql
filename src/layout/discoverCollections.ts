import type { Layout, ObjectStore } from '../types.js';

/** Collection names from the `collection=` common prefixes under the manifests area, sorted. */
export default async function discoverCollections(store: ObjectStore, layout: Layout): Promise<string[]> {
  const base = layout.collectionsPrefix();
  const { prefixes } = await store.list(base, '/');
  const names: string[] = [];
  for (const prefix of prefixes) {
    const segment = prefix.slice(base.length).replace(/\/$/, '');
    if (segment.startsWith('collection=') && segment.length > 'collection='.length) names.push(segment.slice('collection='.length));
  }
  return names.sort();
}
