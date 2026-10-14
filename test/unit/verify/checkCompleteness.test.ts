import { describe, expect, it } from 'vitest';
import type { BatchManifest } from '#types';
import checkCompleteness from '#verify/checkCompleteness';
import { memoryContext } from '../../helpers.js';
import { resolved } from '../load/fixtures.js';

const batch = (completed: number): BatchManifest => ({
  run_id: 'b',
  cutoff_utc: '2026-10-13T01:00:00Z',
  completed_chunks: completed,
  failed_chunks: 0,
  completed_at: null,
});

describe('checkCompleteness', () => {
  it('names a batch with fewer manifests than completed_chunks; flagged chunks never count', () => {
    const { ctx, events } = memoryContext({ command: 'verify' });

    const listed = new Map([
      [
        'b',
        [resolved({ runId: 'r1' }), resolved({ runId: 'r2', manifest: { counts_match: false } })],
      ],
      ['c', [resolved({ runId: 'r3' })]],
    ]);

    const batches = [
      { id: 'b', batch: batch(2) },
      { id: 'c', batch: batch(1) },
      { id: 'd', batch: null },
    ];

    expect(checkCompleteness(ctx, batches, listed, false)).toEqual(['b']);

    expect(events).toEqual([
      {
        type: 'warn',
        command: 'verify',
        message: 'batch b: 1 of 2 completed chunks have a manifest',
      },
    ]);
  });

  it('is skipped with an info line under -C, since a narrowed selection cannot be counted', () => {
    const { ctx, events } = memoryContext({ command: 'verify' });

    expect(checkCompleteness(ctx, [{ id: 'b', batch: batch(5) }], new Map(), true)).toEqual([]);

    expect(events).toEqual([
      {
        type: 'info',
        command: 'verify',
        message: 'batch completeness not checked: -C narrows the run to some collections',
      },
    ]);
  });
});
