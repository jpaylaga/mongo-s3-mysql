import { describe, expect, it } from 'vitest';
import buildChunkManifest from '../../../src/export/buildChunkManifest.js';
import recordSchemas from '../../../src/layout/recordSchemas.js';
import type { ChunkPlan, ManifestInput, PartRef } from '../../../src/types.js';
import { exampleConfig } from '../../helpers.js';
import createLayout from '../../../src/layout/createLayout.js';

const config = exampleConfig();
const layout = createLayout(config.s3);
const batchId = 'app-archive-full-20261013T020304Z';
const window = { start: new Date('2026-03-02T00:00:00Z'), end: new Date('2026-03-03T00:00:00Z') };
const runId = `${batchId}-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z`;

const windowPlan: ChunkPlan = {
  collection: 'audit_log', runId, mode: 'timestamp-window', tail: 'window',
  filter: { created_at: { $gte: window.start, $lt: window.end } },
  filterRecord: { mode: 'timestamp-window', field: 'created_at', start_utc: '2026-03-02T00:00:00+00:00', end_utc: '2026-03-03T00:00:00+00:00', boundary: '[start,end)', hint: 'created_at_1', query: { created_at: { $gte: { $date: { $numberLong: '1772409600000' } }, $lt: { $date: { $numberLong: '1772496000000' } } } } },
  hint: 'created_at_1', paging: 'cursor', brackets: [], rawPrefix: layout.rawPrefix('audit_log', window, runId),
};

const part = (n: number, lines: number): PartRef => {
  const key = layout.part(windowPlan.rawPrefix, n);
  return { key, name: `part-${String(n).padStart(6, '0')}.jsonl.gz`, bytes: 1000 * n, sha256: String(n).repeat(64), s3_uri: layout.uri(key), checksum_s3_uri: layout.uri(`${key}.sha256`), lines };
};

const input = (over: Partial<ManifestInput> = {}): ManifestInput => ({
  plan: windowPlan, partition: layout.partition, sourceCount: 5, sourceCountAfter: 5, exported: 5,
  firstId: '65f1c0a1b2c3d4e5f6a7b8c9', lastId: '65f2a7e09d8c7b6a5f4e3d2c', parts: [part(1, 5)],
  startedAt: new Date('2026-10-13T02:10:11Z'), completedAt: new Date('2026-10-13T02:10:16Z'), toolVersion: 'mongo-s3-mysql@0.1.0', ...over,
});

describe('buildChunkManifest', () => {
  it('writes a single-part chunk exactly like the original exporter plus the tool keys', () => {
    const m = buildChunkManifest(input());
    expect(Object.keys(m)).toEqual([
      'run_id', 'account_id', 'region', 'cluster', 'database', 'collection', 'mode', 'filter', 'format', 'count_source',
      'source_count', 'exported_count', 'counts_match', 'source_count_after', 'first_id', 'last_id', 'file', 'checksum_s3_uri',
      'started_at', 'completed_at', 'schema_version', 'tool',
    ]);
    expect(m).toMatchObject({
      run_id: runId, account_id: '111122223333', database: 'app', collection: 'audit_log', mode: 'timestamp-window',
      format: 'canonical_extended_jsonl_gzip', count_source: 'countDocuments', source_count: 5, exported_count: 5, counts_match: true,
      source_count_after: 5, first_id: '65f1c0a1b2c3d4e5f6a7b8c9', last_id: '65f2a7e09d8c7b6a5f4e3d2c',
      file: { name: 'part-000001.jsonl.gz', bytes: 1000, sha256: '1'.repeat(64), s3_uri: layout.uri(layout.part(windowPlan.rawPrefix, 1)) },
      checksum_s3_uri: `${layout.uri(layout.part(windowPlan.rawPrefix, 1))}.sha256`,
      started_at: '2026-10-13T02:10:11+00:00', completed_at: '2026-10-13T02:10:16+00:00', schema_version: 1, tool: 'mongo-s3-mysql@0.1.0',
    });
    expect(m.parts).toBeUndefined();
    expect((m.filter as { hint?: string }).hint).toBe('created_at_1');
    expect(recordSchemas.chunkManifest.safeParse(m).success).toBe(true);
  });

  it('adds parts[] with line counts only for a multi-part chunk, file still being part 1', () => {
    const m = buildChunkManifest(input({ parts: [part(1, 3), part(2, 2)] }));
    expect(m.file?.name).toBe('part-000001.jsonl.gz');
    expect(m.parts?.map((p) => [p.name, p.lines, p.checksum_s3_uri?.endsWith('.sha256')])).toEqual([['part-000001.jsonl.gz', 3, true], ['part-000002.jsonl.gz', 2, true]]);
  });

  it('flags a count mismatch and writes an empty window with file null', () => {
    const flagged = buildChunkManifest(input({ sourceCountAfter: 6 }));
    expect(flagged.counts_match).toBe(false);
    const empty = buildChunkManifest(input({ sourceCount: 0, sourceCountAfter: 0, exported: 0, firstId: null, lastId: null, parts: [] }));
    expect(empty).toMatchObject({ counts_match: true, file: null, checksum_s3_uri: null, first_id: null, last_id: null, format: 'canonical_extended_jsonl_gzip' });
  });

  it('writes a manifest-only chunk with the manifest_only format and null ids', () => {
    const plan: ChunkPlan = {
      ...windowPlan, mode: 'manifest-only', tail: 'full', filter: {}, paging: 'none', hint: null,
      runId: `${batchId}-coupons-manifest-only-full`, collection: 'coupons',
      filterRecord: { mode: 'manifest-only', filter: 'no raw export; manifest and validation only' },
    };
    const m = buildChunkManifest(input({ plan, sourceCount: 0, sourceCountAfter: 0, exported: 0, parts: [] }));
    expect(m).toMatchObject({ mode: 'manifest-only', format: 'manifest_only', file: null, checksum_s3_uri: null, first_id: null, last_id: null, source_count: 0, exported_count: 0, counts_match: true });
    expect(m.filter).toEqual({ mode: 'manifest-only', filter: 'no raw export; manifest and validation only' });
  });
});
