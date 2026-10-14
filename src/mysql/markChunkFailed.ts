import type { Pool } from 'mysql2/promise';
import redact from '../runtime/redact.js';

/** `_msm_load_chunks.error` is TEXT; the redacted message is clipped well inside it. */
const maxErrorChars = 65_000;

/** Records a chunk's final failure in its ledger row, so `reconcile` and the next load can read the reason. */
export default async function markChunkFailed(pool: Pool, table: string, runId: string, error: string, secrets: readonly string[]): Promise<void> {
  await pool.query(
    "UPDATE `_msm_load_chunks` SET `status` = 'failed', `error` = ?, `updated_at` = UTC_TIMESTAMP(3) WHERE `target_table` = ? AND `chunk_run_id` = ?",
    [redact(error, secrets).slice(0, maxErrorChars), table, runId],
  );
}
