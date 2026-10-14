import { describe, expect, it } from 'vitest';
import recordSchemas from '../../../src/layout/recordSchemas.js';
import { realShape } from '../../helpers.js';

describe('recordSchemas', () => {
  it('accepts the real-shape chunk manifests of all four modes and keeps extras', async () => {
    for (const name of ['chunk-timestamp-window', 'chunk-objectid-window', 'chunk-full-collection', 'chunk-manifest-only']) {
      const parsed = recordSchemas.chunkManifest.parse(await realShape(`${name}.json`));
      expect(parsed.counts_match).toBe(true);
      expect((parsed as Record<string, unknown>).account_id).toBe('111122223333');
      expect((parsed as Record<string, unknown>).area).toBe('example-area');
      expect(parsed.parts).toBeUndefined();
    }
    const only = recordSchemas.chunkManifest.parse(await realShape('chunk-manifest-only.json'));
    expect(only).toMatchObject({ format: 'manifest_only', file: null, checksum_s3_uri: null, first_id: null, exported_count: 0 });
    const full = recordSchemas.chunkManifest.parse(await realShape('chunk-full-collection.json'));
    expect(full.filter).toEqual({ mode: 'full-collection', filter: 'all documents' });
  });

  it('accepts the tool additions on a chunk manifest', async () => {
    const base = await realShape('chunk-timestamp-window.json') as Record<string, unknown>;
    const file = base.file as Record<string, unknown>;
    const parsed = recordSchemas.chunkManifest.parse({
      ...base, schema_version: 1, tool: 'mongo-s3-mysql@0.1.0', source_count_after: 12,
      filter: { ...(base.filter as object), hint: 'created_at_1', query: { created_at: { $gte: { $date: { $numberLong: '1' } } } } },
      parts: [{ ...file, checksum_s3_uri: `${file.s3_uri}.sha256`, lines: 10 }, { ...file, name: 'part-000002.jsonl.gz', checksum_s3_uri: null, lines: 2 }],
    });
    expect(parsed.parts).toHaveLength(2);
    expect(parsed.filter.hint).toBe('created_at_1');
  });

  it('rejects missing required keys, bad modes and bad sha256', async () => {
    const base = await realShape('chunk-timestamp-window.json') as Record<string, unknown>;
    const { counts_match: _dropped, ...withoutCounts } = base;
    expect(recordSchemas.chunkManifest.safeParse(withoutCounts).success).toBe(false);
    expect(recordSchemas.chunkManifest.safeParse({ ...base, mode: 'weekly' }).success).toBe(false);
    expect(recordSchemas.chunkManifest.safeParse({ ...base, file: { ...(base.file as object), sha256: 'nope' } }).success).toBe(false);
    expect(recordSchemas.chunkManifest.safeParse({ ...base, source_count: -1 }).success).toBe(false);
    expect(recordSchemas.chunkManifest.safeParse({ ...base, parts: [] }).success).toBe(false);
    // A part name becomes a local path segment, so it is one plain file name.
    for (const name of ['../../../../tmp/victim/owned.txt', 'a/b.gz', '.', '..', '']) {
      expect(recordSchemas.chunkManifest.safeParse({ ...base, file: { ...(base.file as object), name } }).success, name).toBe(false);
    }
    expect(recordSchemas.chunkManifest.safeParse({ ...base, file: { ...(base.file as object), name: 'part-000001.jsonl.gz' } }).success).toBe(true);
  });

  it('accepts real-shape batch manifests, full and delta, and the tool fields', async () => {
    const full = recordSchemas.batchManifest.parse(await realShape('batch-full.json'));
    expect(full).toMatchObject({ completed_chunks: 4, failed_chunks: 0, cutoff_utc: '2026-10-13T01:00:00Z' });
    expect((full as Record<string, unknown>).covered_areas).toEqual(['example-area']);
    const delta = recordSchemas.batchManifest.parse(await realShape('batch-delta.json'));
    expect(delta.backup_mode).toBe('delta-windowed-with-full-small-collections');
    expect(delta.collection_start_utc).toEqual({ audit_log: '2026-10-12T23:00:00Z', orders: '2026-10-12T23:00:00Z' });
    const running = recordSchemas.batchManifest.parse({
      ...(await realShape('batch-full.json') as object), completed_at: null, status: 'running', started_at: 'x', schema_version: 1, tool: 't',
      plan: { kind: 'full', include_rest: false, collections: [{ collection: 'c', mode: 'full-collection', field: null, window: null, start_utc: null, rest: false }] },
      out_of_range: { audit_log: { before_start: 0, after_cutoff: 2 } },
    });
    expect(running.status).toBe('running');
    expect(running.plan?.collections[0]?.mode).toBe('full-collection');
    expect(recordSchemas.batchManifest.safeParse({ run_id: 'b', cutoff_utc: 'x' }).success).toBe(false);
  });

  it('accepts real-shape validation records and verify additions', async () => {
    const counts = recordSchemas.counts.parse(await realShape('counts.json'));
    expect(counts.matches).toBe(true);
    const pc = recordSchemas.parseCheck.parse(await realShape('parse-check.json'));
    expect(pc.manifest_only).toBe(false);
    expect(pc.ok).toBeUndefined();
    const nulls = recordSchemas.parseCheck.parse({ ...(await realShape('parse-check.json') as object), gzip_test: null, first_line_parseable: null, first_line_has_id: null, manifest_only: true, ok: true, lines: 0, errors: [], manifest_sha256: 'x' });
    expect(nulls.ok).toBe(true);
    expect(recordSchemas.counts.safeParse({ run_id: 'r' }).success).toBe(false);
  });
});
