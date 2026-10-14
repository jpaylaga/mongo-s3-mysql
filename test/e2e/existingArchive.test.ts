import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import createLayout from '#layout/createLayout';
import listChunkManifests from '#layout/listChunkManifests';
import createContext from '#runtime/createContext';
import createS3Store from '#s3/createS3Store';
import type { Config, MysqlHandle, ObjectStore, Window } from '#types';
import { fixturePath } from '../helpers.js';
import runCli from './runCli.js';
import startStack, { configJson, mongoPassword, mysqlPassword, runTool } from './startStack.js';
import type { Stack } from './startStack.js';
import twinDdl from './twinDdl.js';

const auditMappingPath = fileURLToPath(
  new URL('../../examples/audit_log.mapping.json', import.meta.url)
);

/**
 * A batch id the original exporter would have written: no `app-archive-full-` prefix, no tool keys
 * anywhere.
 */
const batchId = 'legacy-exporter-20260302T010000Z';
const sha256 = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex');
const offset = (date: Date): string => `${date.toISOString().slice(0, 19)}+00:00`;
const compact = (date: Date): string => offset(date).replace(/[-:]/g, '').replace('+0000', 'Z');

interface Seeded {
  runId: string;
  key: string;
  lines: number;
}

interface ChunkSpec {
  collection: string;
  mode: 'timestamp-window' | 'full-collection' | 'manifest-only';
  lines: string[];
  window?: Window;
  bom?: boolean;
}

/**
 * Writes one chunk with exactly the original exporter's key sets: a single gzipped part of spaced
 * canonical lines (a BOM on the window part), a `sha256sum` sidecar, the chunk manifest with `area`
 * and `notes`, and the two validation records with their original keys (no `ok`, no
 * `manifest_sha256`): no `parts`, no `tool`.
 */
async function seedChunk(
  store: ObjectStore,
  layout: ReturnType<typeof createLayout>,
  dir: string,
  spec: ChunkSpec
): Promise<Seeded> {
  const { collection, mode } = spec;
  const window = spec.window ?? null;

  const runId =
    mode === 'timestamp-window' && window !== null
      ? `${batchId}-${collection}-timestamp-window-${compact(window.start)}-${compact(window.end)}`
      : `${batchId}-${collection}-${mode}-full`;

  const rawPrefix = layout.rawPrefix(collection, window, runId);
  const key = layout.part(rawPrefix, 1);
  let file: Record<string, unknown> | null = null;

  if (mode !== 'manifest-only') {
    const body = gzipSync(`${spec.bom ? '﻿' : ''}${spec.lines.join('\n')}\n`);
    const path = join(dir, `${runId}.jsonl.gz`);

    await writeFile(path, body);
    await store.putFile(key, path, { contentType: 'application/gzip' });
    await store.putText(`${key}.sha256`, `${sha256(body)}  part-000001.jsonl.gz\n`, 'text/plain');

    file = {
      name: 'part-000001.jsonl.gz',
      bytes: body.length,
      sha256: sha256(body),
      s3_uri: layout.uri(key),
    };
  }

  const idOf = (line: string | undefined): string | null =>
    line === undefined ? null : (JSON.parse(line) as { _id: { $oid: string } })._id.$oid;

  const filter =
    mode === 'timestamp-window' && window !== null
      ? {
          mode,
          field: 'created_at',
          start_utc: offset(window.start),
          end_utc: offset(window.end),
          boundary: '[start,end)',
        }
      : mode === 'full-collection'
        ? { mode, filter: 'all documents' }
        : { mode, filter: 'no raw export; manifest and validation only' };

  const manifest = {
    run_id: runId,
    ...layout.partition,
    collection,
    mode,
    filter,
    format: mode === 'manifest-only' ? 'manifest_only' : 'canonical_extended_jsonl_gzip',
    count_source: 'countDocuments',
    source_count: spec.lines.length,
    exported_count: spec.lines.length,
    counts_match: true,
    first_id: idOf(spec.lines[0]),
    last_id: idOf(spec.lines[spec.lines.length - 1]),
    file,
    checksum_s3_uri: file === null ? null : `${layout.uri(key)}.sha256`,
    started_at: '2026-03-02T01:00:11+00:00',
    completed_at: '2026-03-02T01:00:16+00:00',
    area: 'example-area',
    notes: 'written by the original exporter',
  };

  const counts = {
    run_id: runId,
    collection,
    mode,
    count_source: 'countDocuments',
    source_count: spec.lines.length,
    exported_count: spec.lines.length,
    matches: true,
  };

  const parseCheck = {
    run_id: runId,
    collection,
    mode,
    gzip_test: file === null ? null : true,
    first_line_parseable: file === null ? null : true,
    first_line_has_id: file === null ? null : true,
    manifest_only: mode === 'manifest-only',
  };

  await store.putText(
    layout.counts(collection, runId),
    `${JSON.stringify(counts, null, 2)}\n`,
    'application/json'
  );

  await store.putText(
    layout.parseCheck(collection, runId),
    `${JSON.stringify(parseCheck, null, 2)}\n`,
    'application/json'
  );

  const manifestKey = layout.chunkManifest(collection, runId);

  await store.putText(manifestKey, `${JSON.stringify(manifest, null, 2)}\n`, 'application/json');

  return { runId, key: manifestKey, lines: spec.lines.length };
}

/**
 * Every key under the prefix with its body, so a read-only step can be shown to have left the
 * archive untouched.
 */
async function snapshot(store: ObjectStore): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  for (const key of (await store.list('mongo-archive/')).keys.sort())
    out.set(key, (await store.getText(key)) ?? '');

  return out;
}

describe('existing archive acceptance: verify, infer, load, reconcile without the exporter', () => {
  let stack: Stack;
  let config: Config;
  let store: ObjectStore;
  let layout: ReturnType<typeof createLayout>;
  let before: Map<string, string>;
  const seeded: Seeded[] = [];

  beforeAll(async () => {
    stack = await startStack();

    const collections = [
      {
        name: 'audit_log',
        strategy: 'timestamp-window',
        field: 'created_at',
        window: 'day',
        mapping: auditMappingPath,
      },
    ];

    await writeFile(
      stack.configPath,
      `${JSON.stringify(configJson(stack, { collections }), null, 2)}\n`
    );

    config = stack.config({ collections });
    layout = createLayout(config.s3);
    store = createS3Store(config.s3, createContext({ config, command: 'verify' }));

    const lines = (await readFile(fixturePath('audit_log.sample.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean);

    const window = {
      start: new Date('2026-03-02T00:00:00Z'),
      end: new Date('2026-03-03T00:00:00Z'),
    };

    // One window chunk of audit_log (the one the config maps), a whole small collection, and an
    // empty one.
    seeded.push(
      await seedChunk(store, layout, stack.workDir, {
        collection: 'audit_log',
        mode: 'timestamp-window',
        lines,
        window,
        bom: true,
      })
    );

    seeded.push(
      await seedChunk(store, layout, stack.workDir, {
        collection: 'coupons',
        mode: 'full-collection',
        lines: [
          '{ "_id" : { "$oid" : "69a4d3015a5a5a0002000001" }, "code" : "SPRING10" }',
          '{ "_id" : { "$oid" : "69a4d3015a5a5a0002000002" }, "code" : "SUMMER5" }',
        ],
      })
    );

    seeded.push(
      await seedChunk(store, layout, stack.workDir, {
        collection: 'sessions',
        mode: 'manifest-only',
        lines: [],
      })
    );

    const batch = {
      run_id: batchId,
      ...layout.partition,
      cutoff_utc: '2026-03-03T00:00:00Z',
      covered_areas: ['example-area'],
      completed_chunks: 3,
      failed_chunks: 0,
      completed_at: '2026-03-02T01:01:00+00:00',
      notes: 'written by the original exporter',
    };

    await store.putText(
      layout.batchManifest(batchId),
      `${JSON.stringify(batch, null, 2)}\n`,
      'application/json'
    );

    before = await snapshot(store);
  }, 600_000);

  afterAll(async () => {
    await stack?.stop();
  });

  it('reads the foreign layout: a single part per chunk (or none) and no tool keys', async () => {
    const manifests = (
      await Promise.all(
        ['audit_log', 'coupons', 'sessions'].map(c => listChunkManifests(store, layout, c, batchId))
      )
    ).flat();

    expect(manifests.map(m => m.runId).sort()).toEqual(seeded.map(s => s.runId).sort());

    for (const m of manifests) {
      expect(m.parts.length).toBe(m.manifest.mode === 'manifest-only' ? 0 : 1);

      for (const p of m.parts) expect(p.lines).toBeNull();

      expect(m.manifest.tool).toBeUndefined();
      expect(m.manifest.parts).toBeUndefined();
    }
  });

  it('1-2. verify --no-write discovers and reads all collections, changes no object', async () => {
    // Step 1 of docs/acceptance.md: no collections listed, so verify discovers them from the
    // manifests prefix.
    const discoverPath = join(stack.workDir, 'discover.config.json');

    await writeFile(
      discoverPath,
      `${JSON.stringify(configJson(stack, { collections: [] }), null, 2)}\n`
    );

    const result = await runCli({ ...stack, configPath: discoverPath }, [
      '--json',
      'verify',
      '--no-write',
      '--batch-id',
      batchId,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(mysqlPassword);
    expect(result.stdout + result.stderr).not.toContain(mongoPassword);
    expect(result.stderr).not.toContain('batch completeness not checked');

    const parsed = JSON.parse(result.stdout) as {
      checks: { collection: string; ok: boolean; lines: number }[];
      missing: string[];
      exitCode: number;
    };

    expect(parsed.missing).toEqual([]);

    expect(parsed.checks.map(c => [c.collection, c.ok]).sort()).toEqual([
      ['audit_log', true],
      ['coupons', true],
      ['sessions', true],
    ]);

    expect(parsed.checks.reduce((sum, c) => sum + c.lines, 0)).toBe(
      seeded.reduce((sum, s) => sum + s.lines, 0)
    );

    expect(await snapshot(store)).toEqual(before);

    // The listed config narrows the read to audit_log; the batch tally still covers every archived
    // collection.
    const listed = await runCli(stack, ['verify', '--no-write', '--batch-id', batchId]);

    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stderr).not.toContain('batch completeness not checked');

    // The original exporter's validation records carry no verdict, so a load still has to say
    // --allow-unverified.
    const pc = JSON.parse(
      before.get(layout.parseCheck('audit_log', seeded[0]?.runId as string)) as string
    ) as Record<string, unknown>;

    expect(Object.keys(pc).sort()).toEqual([
      'collection',
      'first_line_has_id',
      'first_line_parseable',
      'gzip_test',
      'manifest_only',
      'mode',
      'run_id',
    ]);
  });

  it('3. infer --batch-id writes a mapping and DDL to review', async () => {
    const result = await runCli(stack, ['infer', '--batch-id', batchId]);

    expect(result.code, result.stderr).toBe(0);

    const mapping = JSON.parse(
      await readFile(join(config.mappingsDir, 'audit_log.mapping.json'), 'utf8')
    ) as {
      table: string;
      key: { cast: string };
      columns: { column: string; cast: string }[];
      inferred: { sampled: number };
    };

    expect(mapping.table).toBe('audit_log');
    expect(mapping.key.cast).toBe('objectId');
    expect(mapping.inferred.sampled).toBe(12);

    expect(Object.fromEntries(mapping.columns.map(c => [c.column, c.cast]))).toMatchObject({
      actor_id: 'string',
      data: 'json',
      created_at: 'datetime',
    });

    expect(await readFile(join(config.mappingsDir, 'audit_log.sql'), 'utf8')).toContain(
      'CREATE TABLE IF NOT EXISTS `audit_log`'
    );
  });

  it('4. load: needs --allow-unverified; dry run writes nothing; real run fills twin', async () => {
    await runTool(stack, 'load', { mysql: true }, { config }, async ({ clients }) => {
      await (clients.mysql as MysqlHandle).pool.query(twinDdl);

      return {};
    });

    const refused = await runCli(stack, ['load', '--batch-id', batchId]);

    expect(refused.code, refused.stderr).toBe(2);
    expect(refused.stderr).toContain('unverified');

    const dry = await runCli(stack, [
      'load',
      '--batch-id',
      batchId,
      '--allow-unverified',
      '--dry-run',
    ]);

    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stderr).toContain('dry run');

    const { value: empty } = await runTool(
      stack,
      'reconcile',
      { mysql: true },
      { config },
      async ({ clients }) => ({
        value: (
          await (clients.mysql as MysqlHandle).pool.query(
            'SELECT COUNT(*) AS c FROM `audit_log_entries`'
          )
        )[0],
      })
    );

    expect(Number((empty as { c: unknown }[])[0]?.c)).toBe(0);

    const real = await runCli(stack, ['load', '--batch-id', batchId, '--allow-unverified']);

    expect(real.code, real.stderr).toBe(0);
    expect(real.stdout + real.stderr).not.toContain(mysqlPassword);

    const { value: rows } = await runTool(
      stack,
      'reconcile',
      { mysql: true },
      { config },
      async ({ clients }) => ({
        value: (
          await (clients.mysql as MysqlHandle).pool.query(
            'SELECT `source_mongo_id`, `created_at`, `data` FROM `audit_log_entries` ORDER BY `id`'
          )
        )[0] as Record<string, unknown>[],
      })
    );

    expect(rows).toHaveLength(12);

    // The first fixture document: 2026-03-02T00:00:01.527Z is 08:00:01 on the Manila wall clock,
    // truncated.
    expect(rows.find(r => r.source_mongo_id === '69a4d3015a5a5a0001000001')?.created_at).toBe(
      '2026-03-02 08:00:01'
    );

    expect(rows.filter(r => r.created_at === null)).toHaveLength(1);
  });

  it('5. reconcile --batch-id passes, --deep proves rows vs parts, prefix unchanged', async () => {
    const plain = await runCli(stack, ['reconcile', '--batch-id', batchId]);

    expect(plain.code, plain.stderr).toBe(0);

    const deep = await runCli(stack, ['reconcile', '--batch-id', batchId, '--deep']);

    expect(deep.code, deep.stderr).toBe(0);
    expect(deep.stdout).toContain('next:');
    expect(deep.stdout + deep.stderr).not.toContain(mysqlPassword);
    expect(deep.stdout + deep.stderr).not.toContain(mongoPassword);
    // The read-only acceptance step: the whole run against an existing archive uses List and Get
    // alone.
    expect(await snapshot(store)).toEqual(before);
  });
});
