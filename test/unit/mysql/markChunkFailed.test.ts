import { describe, expect, it } from 'vitest';
import markChunkFailed from '../../../src/mysql/markChunkFailed.js';
import { fakeMysql, header } from './fakeMysql.js';

describe('markChunkFailed', () => {
  it('records the redacted, clipped error on the chunk row', async () => {
    const { pool, calls } = fakeMysql([[/^UPDATE `_msm_load_chunks` SET `status` = 'failed'/, header(1)]]);
    await markChunkFailed(pool, 'audit_log_entries', 'b-c-full-collection-full', `connect failed for hunter2 ${'x'.repeat(70_000)}`, ['hunter2']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params[0]).toMatch(/^connect failed for \*\*\* x+$/);
    expect((calls[0]?.params[0] as string).length).toBe(65_000);
    expect(calls[0]?.params.slice(1)).toEqual(['audit_log_entries', 'b-c-full-collection-full']);
  });
});
