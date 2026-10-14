import type { CollectionConfig } from '#types';

/**
 * The config entry of a collection the file does not list: the schema defaults, no strategy, no
 * mapping.
 */
export default function bareCollection(
  name: string,
  window: 'hour' | 'day' = 'day'
): CollectionConfig {
  return { name, window, rest: 'auto' };
}
