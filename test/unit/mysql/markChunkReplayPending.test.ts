import { describe, expect, it } from 'vitest';
import markChunkReplayPending from '#mysql/markChunkReplayPending';
import replayPendingSha from '#mysql/replayPendingSha';
import { fakeMysql, header } from './fakeMysql.js';

describe('markChunkReplayPending', () => {
  it('sets the chunk row back to loading under the replay sentinel sha', async () => {
    const { pool, calls } = fakeMysql([
      [/^UPDATE `_msm_load_chunks` SET `status` = 'loading', `manifest_sha256` = \?/, header(1)],
    ]);

    await markChunkReplayPending(pool, 'audit_log_entries', 'b-c-full-collection-full');
    expect(calls).toHaveLength(1);

    expect(calls[0]?.params).toEqual([
      replayPendingSha,
      'audit_log_entries',
      'b-c-full-collection-full',
    ]);
  });
});
