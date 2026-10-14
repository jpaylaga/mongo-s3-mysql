import { describe, expect, it } from 'vitest';
import selectCollections from '#config/selectCollections';
import { exampleConfig } from '../../helpers.js';

describe('selectCollections', () => {
  const config = exampleConfig();

  it('-C names win and keep the configured entry when there is one', () => {
    const picked = selectCollections(config, ['orders', 'sessions']);

    expect(picked.map(c => c.name)).toEqual(['orders', 'sessions']);
    expect(picked[0]?.strategy).toBe('objectid-window');
    expect(picked[1]).toEqual({ name: 'sessions', window: 'day', rest: 'auto' });
  });

  it('falls back to the configured list; an empty one leaves discovery to the orchestrator', () => {
    expect(selectCollections(config).map(c => c.name)).toEqual(['audit_log', 'orders', 'coupons']);

    const empty = exampleConfig({ collections: [] });

    expect(selectCollections(empty)).toEqual([]);
    expect(selectCollections(empty, [])).toEqual([]);
  });

  it('returns copies, not the config array itself', () => {
    const picked = selectCollections(config);

    picked.pop();
    expect(config.collections).toHaveLength(3);
  });
});
