import formatCount from '../runtime/formatCount.js';
import type { BatchManifest, Drift, LedgerRow, ResolvedManifest } from '../types.js';


/** A batch is complete only when the exporter said so: no failed chunks, a completion time, and the tool status `complete`. */
function batchDrift(table: string, batch: BatchManifest): Drift | null {
  const reasons: string[] = [];
  if (batch.failed_chunks > 0) reasons.push(`failed_chunks ${formatCount(batch.failed_chunks)}`);
  if (batch.completed_at === null) reasons.push('completed_at null');
  if (batch.status !== undefined && batch.status !== 'complete') reasons.push(`status ${batch.status}`);
  if (reasons.length === 0) return null;
  return {
    table, kind: 'batch_incomplete', chunk: null,
    expected: batch.completed_chunks + batch.failed_chunks, actual: batch.completed_chunks,
    detail: `batch ${batch.run_id}: ${reasons.join(', ')}; missing chunks have no manifest and are not listed below`,
  };
}

/** The ledger's own arithmetic for one loaded chunk against the manifest it was loaded from. */
function rowDrifts(table: string, resolved: ResolvedManifest, row: LedgerRow): Drift[] {
  const drifts: Drift[] = [];
  const exported = resolved.manifest.exported_count;
  const chunk = resolved.runId;
  if (row.manifest_sha256 !== resolved.sha256) {
    drifts.push({ table, kind: 'manifest_changed', chunk, expected: null, actual: null,
      detail: `ledger manifest_sha256 ${row.manifest_sha256.slice(0, 12)} differs from the manifest object's ${resolved.sha256.slice(0, 12)} now; load --reload re-applies it` });
  }
  if (row.status !== 'loaded') {
    drifts.push({ table, kind: 'load_incomplete', chunk, expected: exported, actual: row.lines_done,
      detail: `status ${row.status}, ${formatCount(row.lines_done)} of ${formatCount(exported)} lines applied${row.error ? `; last error: ${row.error}` : ''}` });
    // An unfinished load has not reached exported_count by definition; one drift says so.
    return drifts;
  }
  const accounted = row.rows_inserted + row.rows_updated + row.duplicates_skipped + row.rows_rejected;
  if (accounted !== exported || row.lines_done !== exported) {
    drifts.push({ table, kind: 'line_count', chunk, expected: exported, actual: accounted,
      detail: `inserted ${formatCount(row.rows_inserted)} + updated ${formatCount(row.rows_updated)} + duplicates ${formatCount(row.duplicates_skipped)} + rejected ${formatCount(row.rows_rejected)} = ${formatCount(accounted)}, lines_done ${formatCount(row.lines_done)}, exported_count ${formatCount(exported)}` });
  }
  return drifts;
}

/**
 * Drifts the records alone can prove, without touching the target table: every chunk manifest
 * of the selected batches against the ledger rows loaded from them, plus each batch manifest's own verdict.
 * A ledger row whose manifest is gone is reported as `manifest_changed`: what was loaded can no longer be
 * compared with anything.
 */
export default function chunkDrift(name: string, batches: BatchManifest[], manifests: ResolvedManifest[], ledger: LedgerRow[]): Drift[] {
  const drifts: Drift[] = [];
  for (const batch of batches) {
    const drift = batchDrift(name, batch);
    if (drift !== null) drifts.push(drift);
  }

  const rows = new Map(ledger.map((row) => [row.chunk_run_id, row]));
  const seen = new Set<string>();
  for (const resolved of manifests) {
    seen.add(resolved.runId);
    const row = rows.get(resolved.runId);
    if (row === undefined) {
      const flagged = resolved.manifest.counts_match ? '' : ' (flagged: counts did not match at export; load needs --allow-mismatch)';
      drifts.push({ table: name, kind: 'not_loaded', chunk: resolved.runId, expected: resolved.manifest.exported_count, actual: 0,
        detail: `no ledger row for this chunk${flagged}` });
      continue;
    }
    drifts.push(...rowDrifts(name, resolved, row));
  }

  for (const row of ledger) {
    if (seen.has(row.chunk_run_id)) continue;
    drifts.push({ table: name, kind: 'manifest_changed', chunk: row.chunk_run_id, expected: row.exported_count, actual: null,
      detail: `ledger row ${row.id} (${row.status}) has no manifest object at ${row.manifest_key} any more` });
  }
  return drifts;
}
