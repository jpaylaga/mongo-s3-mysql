import type { LedgerRow, ResolvedManifest, ChunkManifest, Window } from '../../../src/types.js';
import chunkRunId from '../../../src/layout/chunkRunId.js';

export const noSuchTable = (name: string) => Object.assign(new Error(`Table 'archive.${name}' doesn't exist`), { errno: 1146, code: 'ER_NO_SUCH_TABLE', sqlState: '42S02' });

export const batchId = 'app-archive-full-20261013T020304Z';
export const day = (d: string): Window => ({ start: new Date(`${d}T00:00:00Z`), end: new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000) });

/** A ledger row as readLedger returns it (numbers already converted). */
export function ledgerRow(over: Partial<LedgerRow> = {}): LedgerRow {
  const exported = over.exported_count ?? 100;
  return {
    id: 1, target_table: 'audit_log_entries', collection: 'audit_log', batch_id: batchId,
    chunk_run_id: chunkRunId(batchId, 'audit_log', 'timestamp-window', day('2026-03-02')),
    batch_cutoff_utc: '2026-10-13T02:00:00Z', manifest_key: 'mongo-archive/manifests/x/run_id=r.json',
    manifest_sha256: 'a'.repeat(64), mapping_sha256: 'b'.repeat(64), exported_count: exported, lines_done: exported,
    rows_inserted: exported, rows_updated: 0, duplicates_skipped: 0, rows_rejected: 0, cast_errors: 0,
    status: 'loaded', attempts: 1, load_run_id: 'load-20261013T040000Z', error: null, finished_at: '2026-10-13 04:05:00.000',
    ...over,
  };
}

/** A resolved chunk manifest with only what chunkDrift and deepCheck read; `manifest` patches the record. */
export function resolved(over: Omit<Partial<ResolvedManifest>, 'manifest'> & { manifest?: Partial<ChunkManifest> } = {}): ResolvedManifest {
  const { manifest: patch, ...rest } = over;
  const runId = rest.runId ?? chunkRunId(batchId, 'audit_log', 'timestamp-window', day('2026-03-02'));
  const manifest: ChunkManifest = {
    run_id: runId, collection: 'audit_log', mode: 'timestamp-window',
    filter: { mode: 'timestamp-window', field: 'created_at', start_utc: '2026-03-02T00:00:00+00:00', end_utc: '2026-03-03T00:00:00+00:00', boundary: '[start,end)' },
    format: 'canonical_extended_jsonl_gzip', count_source: 'countDocuments', source_count: 100, exported_count: 100, counts_match: true,
    first_id: null, last_id: null, file: null, checksum_s3_uri: null, started_at: '2026-10-13T02:10:11+00:00', completed_at: '2026-10-13T02:10:16+00:00',
    ...(patch ?? {}),
  };
  return {
    key: `mongo-archive/manifests/x/collection=audit_log/run_id=${runId}.json`, sha256: 'a'.repeat(64), text: '{}',
    batchId, collection: 'audit_log', runId, id: { mode: 'timestamp-window', window: day('2026-03-02'), tail: 'window' }, parts: [],
    ...rest, manifest,
  };
}
