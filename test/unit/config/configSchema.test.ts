import { describe, expect, it } from 'vitest';
import configSchema from '#config/configSchema';
import { exampleConfigJson } from '../../helpers.js';

const minimal = { mongo: { database: 'app' }, s3: { bucket: 'example-archive-bucket' } };

describe('configSchema', () => {
  it('parses the example config and fills defaults', () => {
    const c = configSchema.parse(exampleConfigJson);

    expect(c.mongo.readPreference).toBe('secondaryPreferred');
    expect(c.mongo.batchSize).toBe(1000);
    expect(c.s3.partSizeMb).toBe(16);
    expect(c.s3.storageClass).toBe('STANDARD');
    expect(c.mysql?.port).toBe(3306);
    expect(c.mysql?.sessionTimeZone).toBe('+00:00');
    expect(c.retry).toEqual({ attempts: 8, baseDelayMs: 500, maxDelayMs: 60_000 });
    expect(c.export.partMaxDocs).toBe(5_000_000);
    expect(c.export.batchPrefix).toBe('app-archive');
    expect(c.load.keyLedger).toBe(true);
    expect(c.collections[0]).toMatchObject({ name: 'audit_log', window: 'day', rest: 'auto' });
  });

  it('needs only mongo and s3; mysql is optional', () => {
    const c = configSchema.parse(minimal);

    expect(c.mysql).toBeUndefined();
    expect(c.stateDir).toBe('.mongo-s3-mysql');
    expect(c.collections).toEqual([]);
  });

  it('a collection start is an instant with an offset at second precision', () => {
    const start = (value: string) =>
      configSchema.safeParse({
        ...minimal,
        collections: [{ name: 'a', strategy: 'objectid-window', start: value }],
      }).success;

    expect(start('2026-10-12T00:00:00Z')).toBe(true);
    expect(start('2026-10-12T08:00:00+08:00')).toBe(true);
    expect(start('2026-10-12T00:00:00')).toBe(false);
    expect(start('2026-10-12T00:00:00.500Z')).toBe(false);
  });

  it('rejects unknown keys at every level', () => {
    expect(configSchema.safeParse({ ...minimal, extra: 1 }).success).toBe(false);

    expect(configSchema.safeParse({ ...minimal, s3: { bucket: 'b-b-b', typo: 1 } }).success).toBe(
      false
    );

    expect(
      configSchema.safeParse({ ...minimal, collections: [{ name: 'a', nope: 1 }] }).success
    ).toBe(false);
  });

  it('keeps partition key order and refuses reserved and non-snake keys', () => {
    const c = configSchema.parse({
      ...minimal,
      s3: { bucket: 'b-b-b', partition: { zeta: 'z', alpha: 'a' } },
    });

    expect(Object.keys(c.s3.partition)).toEqual(['zeta', 'alpha']);

    expect(
      configSchema.safeParse({ ...minimal, s3: { bucket: 'b-b-b', partition: { run_id: 'x' } } })
        .success
    ).toBe(false);

    // Every key the tool writes into a chunk or batch manifest is reserved: a partition value there
    // would be overwritten.
    for (const key of [
      'status',
      'started_at',
      'completed_at',
      'source_count',
      'cutoff_utc',
      'plan',
      'out_of_range',
      'counts_match',
    ]) {
      expect(
        configSchema.safeParse({
          ...minimal,
          s3: { bucket: 'b-b-b', partition: { [key]: 'prod' } },
        }).success,
        key
      ).toBe(false);
    }

    expect(
      configSchema.safeParse({ ...minimal, s3: { bucket: 'b-b-b', partition: { Region: 'x' } } })
        .success
    ).toBe(false);

    expect(
      configSchema.safeParse({
        ...minimal,
        s3: { bucket: 'b-b-b', partition: { region: 'us east' } },
      }).success
    ).toBe(false);
  });

  it('refuses prototype names as collection names, which are plain-object manifest keys', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(configSchema.safeParse({ ...minimal, collections: [{ name }] }).success, name).toBe(
        false
      );
    }

    expect(configSchema.safeParse({ ...minimal, collections: [{ name: 'proto' }] }).success).toBe(
      true
    );
  });

  it('bounds mysql.sessionTimeZone to what MySQL accepts (-13:59 to +14:00)', () => {
    const tz = (sessionTimeZone: string) =>
      configSchema.safeParse({
        ...minimal,
        mysql: { host: 'h', user: 'u', database: 'd', sessionTimeZone },
      }).success;

    expect(tz('+08:00')).toBe(true);
    expect(tz('+14:00')).toBe(true);
    expect(tz('-13:59')).toBe(true);
    expect(tz('+15:00')).toBe(false);
    expect(tz('-14:00')).toBe(false);
    expect(tz('+08:60')).toBe(false);
    expect(tz('UTC')).toBe(false);
  });

  it('trims slashes off the prefix', () => {
    expect(
      configSchema.parse({ ...minimal, s3: { bucket: 'b-b-b', prefix: '/a/b/' } }).s3.prefix
    ).toBe('a/b');
  });

  it('enforces the strategy and field rules', () => {
    const withCollections = (collections: unknown[]) =>
      configSchema.safeParse({ ...minimal, collections });

    expect(withCollections([{ name: 'a', strategy: 'timestamp-window' }]).success).toBe(false);

    expect(withCollections([{ name: 'a', strategy: 'objectid-window', field: 'x' }]).success).toBe(
      false
    );

    expect(
      withCollections([{ name: 'a', strategy: 'timestamp-window', field: 'created_at' }]).success
    ).toBe(true);

    expect(withCollections([{ name: 'a' }, { name: 'a' }]).success).toBe(false);
    expect(withCollections([{ name: 'system.views' }]).success).toBe(false);
  });

  it('requires a kms key for aws:kms and ordered retry delays', () => {
    expect(
      configSchema.safeParse({ ...minimal, s3: { bucket: 'b-b-b', sse: 'aws:kms' } }).success
    ).toBe(false);

    expect(
      configSchema.safeParse({ ...minimal, s3: { bucket: 'b-b-b', sse: 'aws:kms', kmsKeyId: 'k' } })
        .success
    ).toBe(true);

    expect(
      configSchema.safeParse({ ...minimal, retry: { baseDelayMs: 1000, maxDelayMs: 10 } }).success
    ).toBe(false);
  });

  it('validates env var names and numeric ranges', () => {
    expect(
      configSchema.safeParse({ ...minimal, mongo: { database: 'app', uriEnv: 'lower' } }).success
    ).toBe(false);

    expect(configSchema.safeParse({ ...minimal, export: { concurrency: 0 } }).success).toBe(false);

    expect(configSchema.safeParse({ ...minimal, export: { concurrency: 2.5 } }).success).toBe(
      false
    );

    expect(
      configSchema.safeParse({
        ...minimal,
        mysql: { host: 'h', user: 'u', database: 'd', sessionTimeZone: 'UTC' },
      }).success
    ).toBe(false);
  });
});
