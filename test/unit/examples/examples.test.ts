import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import parseConfig from '#config/parseConfig';
import loadMapping from '#mapping/loadMapping';
import mappingSchema from '#mapping/mappingSchema';
import mappingToDdl from '#mapping/mappingToDdl';

const examplesDir = fileURLToPath(new URL('../../../examples/', import.meta.url));

describe('examples/', () => {
  it('ships exactly the config and the two mappings the docs refer to', async () => {
    expect((await readdir(examplesDir)).sort()).toEqual([
      'audit_log.mapping.json',
      'mongo-s3-mysql.config.json',
      'orders.mapping.json',
    ]);
  });

  it('mongo-s3-mysql.config.json validates and carries the documented example values', async () => {
    const raw = JSON.parse(
      await readFile(join(examplesDir, 'mongo-s3-mysql.config.json'), 'utf8')
    ) as unknown;

    const config = parseConfig(raw, examplesDir, 'examples/mongo-s3-mysql.config.json');

    expect(config.mongo).toMatchObject({ uriEnv: 'MSM_MONGO_URI', database: 'app' });

    expect(config.s3).toMatchObject({
      bucket: 'example-archive-bucket',
      prefix: 'mongo-archive',
      region: 'us-east-1',
    });

    expect(Object.keys(config.s3.partition)).toEqual([
      'account_id',
      'region',
      'cluster',
      'database',
    ]);

    expect(config.mysql).toMatchObject({
      host: 'mysql.example.internal',
      user: 'archive_loader',
      database: 'archive',
      passwordEnv: 'MSM_MYSQL_PASSWORD',
    });

    expect(config.export).toMatchObject({ batchPrefix: 'app-archive', concurrency: 4 });

    expect(config.collections.map(c => [c.name, c.strategy])).toEqual([
      ['audit_log', 'timestamp-window'],
      ['orders', 'objectid-window'],
      ['coupons', 'full-collection'],
    ]);
  });

  it('every *.mapping.json validates against mappingSchema and produces DDL', async () => {
    for (const name of ['audit_log.mapping.json', 'orders.mapping.json']) {
      const raw = JSON.parse(await readFile(join(examplesDir, name), 'utf8')) as unknown;
      const parsed = mappingSchema.safeParse(raw);

      expect(parsed.success, name).toBe(true);

      const loaded = await loadMapping(join(examplesDir, name));

      expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(mappingToDdl(loaded.mapping).length).toBeGreaterThan(0);
    }
  });

  it('audit_log.mapping.json is the twin mapping of docs/use-case.md', async () => {
    const { mapping } = await loadMapping(join(examplesDir, 'audit_log.mapping.json'));

    expect(mapping).toMatchObject({
      collection: 'audit_log',
      table: 'audit_log_entries',
      key: { column: 'source_mongo_id', cast: 'objectId' },
      runIdColumn: 'backfill_run_id',
      onCastError: 'reject',
    });

    const casts = Object.fromEntries(mapping.columns.map(c => [c.column, c.cast]));

    expect(casts).toEqual({
      actor_id: 'string',
      description: 'string',
      data: 'json',
      ip_address: 'string',
      location: 'json',
      created_at: 'datetime',
      updated_at: 'datetime',
    });

    expect(
      mapping.columns
        .filter(c => c.cast === 'datetime')
        .every(c => c.timezone === 'Asia/Manila' && c.fsp === 0)
    ).toBe(true);
  });

  it('orders.mapping.json is the golden infer output with children and provenance', async () => {
    const { mapping } = await loadMapping(join(examplesDir, 'orders.mapping.json'));

    expect(mapping).toMatchObject({
      collection: 'orders',
      table: 'orders',
      key: { column: 'mongo_id', cast: 'objectId', sqlType: 'CHAR(24)' },
      runIdColumn: 'import_run',
      chunkColumn: '_msm_chunk',
      extraColumn: '_extra',
    });

    expect(mapping.children.map(c => c.table)).toEqual(['orders_items']);

    expect(mapping.inferred).toMatchObject({
      tool: expect.stringMatching(/^mongo-s3-mysql@\d+\.\d+\.\d+/),
      sampled: 60,
    });
  });
});
