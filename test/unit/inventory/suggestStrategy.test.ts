import { describe, expect, it } from 'vitest';
import suggestStrategy from '../../../src/inventory/suggestStrategy.js';
import type { InventoryFacts } from '../../../src/types.js';

const facts = (overrides: Partial<InventoryFacts> = {}): InventoryFacts => ({
  name: 'orders', estimatedCount: 5_000_000, indexedFields: ['_id'], idTypes: { objectId: 100 }, dateFields: [], objectIdTime: null, ...overrides,
});

describe('suggestStrategy', () => {
  it('goes whole up to 1,000,000 documents, whatever the ids look like', () => {
    const small = suggestStrategy(facts({ estimatedCount: 1_000_000, idTypes: { string: 50, objectId: 50 } }));
    expect(small).toEqual({ name: 'orders', strategy: 'full-collection', window: 'day', rest: 'auto', reason: 'about 1,000,000 documents, one keyset chunk', warn: false });
    expect(suggestStrategy(facts({ estimatedCount: 1_000_001 })).strategy).toBe('objectid-window');
  });

  it('windows on ObjectIds when every sampled id is one, hourly above 2,000,000 documents a day', () => {
    const tenDays = { min: '2026-03-01T00:00:00Z', max: '2026-03-11T00:00:00Z' };
    const daily = suggestStrategy(facts({ estimatedCount: 20_000_000, objectIdTime: tenDays }));
    expect(daily).toMatchObject({ strategy: 'objectid-window', window: 'day', rest: 'auto' });
    expect(daily.reason).toBe('every sampled _id is an ObjectId, about 2,000,000 documents per day; rest: auto skips the rest chunk; set rest: export or pass --include-rest');
    expect(suggestStrategy(facts({ estimatedCount: 20_000_001, objectIdTime: tenDays })).window).toBe('hour');
    // Without bounds the rate is unknown, so the safer day window stands.
    expect(suggestStrategy(facts({ estimatedCount: 90_000_000 }))).toMatchObject({ window: 'day', reason: expect.stringMatching(/^every sampled _id is an ObjectId; /) });
    // A span under a day counts as one day, so a fresh busy collection still gets hour windows.
    expect(suggestStrategy(facts({ estimatedCount: 3_000_000, objectIdTime: { min: '2026-03-01T00:00:00Z', max: '2026-03-01T01:00:00Z' } })).window).toBe('hour');
  });

  it('needs every sampled id to be an ObjectId', () => {
    const mixed = facts({ idTypes: { objectId: 99, string: 1 }, dateFields: [{ field: 'created_at', ratio: 1, indexed: true }] });
    expect(suggestStrategy(mixed).strategy).toBe('timestamp-window');
    expect(suggestStrategy(facts({ idTypes: {} })).strategy).toBe('full-collection');
  });

  it('windows on an indexed date field present in at least 99% of samples, preferring created* then *_at', () => {
    const dates = (fields: [string, number, boolean][]) => fields.map(([field, ratio, indexed]) => ({ field, ratio, indexed }));
    const ts = (dateFields: InventoryFacts['dateFields']) => suggestStrategy(facts({ idTypes: { string: 100 }, dateFields }));
    const pick = ts(dates([['updated_at', 1, true], ['created_at', 0.99, true], ['createdOn', 1, true]]));
    expect(pick).toMatchObject({ strategy: 'timestamp-window', field: 'created_at', window: 'day', rest: 'auto' });
    expect(pick.reason).toBe('indexed created_at is a date in 99% of samples; rest: auto skips the rest chunk; set rest: export or pass --include-rest');
    expect(ts(dates([['updatedAt', 0.999, true], ['expires', 1, true]])).field).toBe('updatedAt');
    expect(ts(dates([['expires', 1, true], ['zzz', 1, true]])).field).toBe('expires');
    expect(ts(dates([['created_at', 0.989, true]])).strategy).toBe('full-collection');
    expect(ts(dates([['created_at', 1, false]])).strategy).toBe('full-collection');
  });

  it('falls back to one keyset chunk with the large-collection warning as the reason', () => {
    const large = suggestStrategy(facts({ idTypes: { string: 100 } }));
    expect(large).toEqual({ name: 'orders', strategy: 'full-collection', window: 'day', rest: 'auto', reason: 'large collection, one keyset chunk', warn: true });
    expect('field' in large).toBe(false);
  });
});
