import isObject from '../ejson/isObject.js';
import type { InventoryReport } from '../types.js';

/**
 * The config object with `collections` replaced by the inventory's suggestions (`inventory --write-config`).
 * The user's per-collection choices that inventory cannot know (`start`, `rest`, `mapping`) survive for a
 * collection that keeps its name; everything else in the file is left as it was.
 */
export default function mergeConfigCollections(raw: Record<string, unknown>, report: InventoryReport): Record<string, unknown> {
  const existing = Array.isArray(raw.collections) ? raw.collections.filter(isObject) : [];
  const previous = new Map(existing.map((c) => [c.name, c]));
  const collections = report.collections.map(({ name, suggestion }) => {
    const kept = previous.get(name) ?? {};
    const windowed = suggestion.strategy !== 'full-collection';
    return {
      name, strategy: suggestion.strategy, ...(suggestion.field ? { field: suggestion.field } : {}), ...(windowed ? { window: suggestion.window } : {}),
      ...('start' in kept ? { start: kept.start } : {}), ...('rest' in kept ? { rest: kept.rest } : {}), ...('mapping' in kept ? { mapping: kept.mapping } : {}),
    };
  });
  return { ...raw, collections };
}
