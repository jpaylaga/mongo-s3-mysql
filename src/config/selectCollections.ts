import type { CollectionConfig, Config } from '../types.js';
import bareCollection from './bareCollection.js';

/**
 * `-C a,b` wins (unconfigured names get defaults), then the configured list. An empty result means "every
 * collection": the orchestrators discover them themselves, from Mongo (inventory, export) or from the
 * manifests prefix (verify, infer, load, reconcile), and give each one `bareCollection`'s defaults.
 */
export default function selectCollections(config: Config, names?: string[]): CollectionConfig[] {
  const configured = new Map(config.collections.map((c) => [c.name, c]));
  if (names && names.length > 0) return names.map((n) => configured.get(n) ?? bareCollection(n));
  return [...config.collections];
}
