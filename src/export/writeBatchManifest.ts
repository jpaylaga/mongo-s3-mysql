import recordJson from '../layout/recordJson.js';
import formatUtc from '../runtime/formatUtc.js';
import toolVersion from '../runtime/toolVersion.js';
import type { BatchPlan, BatchStatus, ExportDeps } from '../types.js';

/**
 * The batch manifest: written once with `status: running` as the frozen plan (and as the S3
 * write preflight), then rewritten at the end of every invocation with the tally. Delta keys follow the
 * original exporter's names so its readers keep working. The orchestrator passes its clock as `now`.
 */
export default async function writeBatchManifest(
  deps: ExportDeps,
  batch: BatchPlan,
  status: BatchStatus,
  tally: { completed: number; failed: number; now: Date; notes?: string },
): Promise<void> {
  if (tally.completed < 0 || tally.failed < 0) throw new RangeError(`batch ${batch.batchId}: negative tally (${tally.completed} completed, ${tally.failed} failed)`);
  const windowed = batch.collections.filter((c) => c.mode !== 'full-collection' && c.start_utc !== null);
  const record: Record<string, unknown> = {
    run_id: batch.batchId,
    ...deps.layout.partition,
    cutoff_utc: formatUtc(batch.cutoff, 'z'),
    ...(batch.kind === 'delta'
      ? {
        backup_mode: 'delta-windowed-with-full-small-collections',
        ...(batch.since === null ? {} : { requested_start_utc: formatUtc(batch.since, 'z') }),
        collection_start_utc: Object.fromEntries(windowed.map((c) => [c.collection, c.start_utc])),
      }
      : {}),
    completed_chunks: tally.completed,
    failed_chunks: tally.failed,
    completed_at: status === 'running' ? null : formatUtc(tally.now, 'offset'),
    ...(tally.notes === undefined ? {} : { notes: tally.notes }),
    schema_version: 1,
    tool: toolVersion,
    status,
    started_at: formatUtc(batch.startedAt, 'offset'),
    out_of_range: batch.outOfRange,
    plan: { kind: batch.kind, include_rest: batch.includeRest, collections: batch.collections },
  };
  await deps.store.putText(deps.layout.batchManifest(batch.batchId), recordJson(record), 'application/json');
}
