import { describe, expect, it } from 'vitest';
import bareCollection from '../../../src/config/bareCollection.js';
import configSchema from '../../../src/config/configSchema.js';

describe('bareCollection', () => {
  it('is the schema\'s own defaults for a collection the config does not list', () => {
    expect(bareCollection('jobs')).toEqual({ name: 'jobs', window: 'day', rest: 'auto' });
    expect(bareCollection('jobs', 'hour')).toEqual({ name: 'jobs', window: 'hour', rest: 'auto' });
    const parsed = configSchema.parse({ mongo: { database: 'app' }, s3: { bucket: 'b-b-b' }, collections: [{ name: 'jobs' }] });
    expect(parsed.collections[0]).toEqual(bareCollection('jobs'));
  });
});
