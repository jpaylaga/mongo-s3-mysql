import type { Pool } from 'mysql2/promise';
import replayPendingSha from '#mysql/replayPendingSha';

/**
 * Persists a forced replay before the older batch writes: the chunk's ledger row goes back to
 * `loading` under the sentinel manifest sha, so a run interrupted between the two batches is
 * followed by a plain `load` that still replays the newer chunk from line 0.
 */
export default async function markChunkReplayPending(
  pool: Pool,
  table: string,
  runId: string
): Promise<void> {
  await pool.query(
    "UPDATE `_msm_load_chunks` SET `status` = 'loading', `manifest_sha256` = ?, " +
      '`updated_at` = UTC_TIMESTAMP(3) WHERE `target_table` = ? AND `chunk_run_id` = ' +
      '?',
    [replayPendingSha, table, runId]
  );
}
