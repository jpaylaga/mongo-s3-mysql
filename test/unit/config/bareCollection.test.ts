import { describe, expect, it } from 'vitest';
import bareCollection from '#config/bareCollection';
import configSchema from '#config/configSchema';

describe('bareCollection', () => {
  it("is the schema's own defaults for a collection the config does not list", () => {
    expect(bareCollection('jobs')).toEqual({ name: 'jobs', window: 'day', rest: 'auto' });
    expect(bareCollection('jobs', 'hour')).toEqual({ name: 'jobs', window: 'hour', rest: 'auto' });

    const parsed = configSchema.parse({
      mongo: { database: 'app' },
      s3: { bucket: 'b-b-b' },
      collections: [{ name: 'jobs' }],
    });

    expect(parsed.collections[0]).toEqual(bareCollection('jobs'));
  });
});
