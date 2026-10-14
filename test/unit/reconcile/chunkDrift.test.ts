import { describe, expect, it } from 'vitest';
import chunkDrift from '#reconcile/chunkDrift';
import type { BatchManifest } from '#types';
import { batchId, ledgerRow, resolved } from './fixtures.js';

const table = 'audit_log_entries';

const batch = (over: Partial<BatchManifest> = {}): BatchManifest => ({
  run_id: batchId,
  cutoff_utc: '2026-10-13T02:00:00Z',
  completed_chunks: 3,
  failed_chunks: 0,
  completed_at: '2026-10-13T02:11:00+00:00',
  ...over,
});

const kinds = (drifts: ReturnType<typeof chunkDrift>) => drifts.map(d => d.kind);

describe('chunkDrift', () => {
  it('reports nothing when every manifest is loaded, adds up, and its batch is complete', () => {
    const m = resolved();

    expect(chunkDrift(table, [batch()], [m], [ledgerRow()])).toEqual([]);
    // A foreign batch manifest has no `status`; completed_at and failed_chunks alone decide.
    expect(chunkDrift(table, [batch({ status: 'complete' })], [m], [ledgerRow()])).toEqual([]);
  });

  it('batch_incomplete: failed chunks, no completion time, or a status other than complete', () => {
    const m = resolved();
    const rows = [ledgerRow()];
    const failed = chunkDrift(table, [batch({ failed_chunks: 2, completed_chunks: 1 })], [m], rows);

    expect(failed).toEqual([
      {
        table,
        kind: 'batch_incomplete',
        chunk: null,
        expected: 3,
        actual: 1,
        detail: expect.stringContaining('failed_chunks 2'),
      },
    ]);

    expect(chunkDrift(table, [batch({ completed_at: null })], [m], rows)[0]?.detail).toContain(
      'completed_at null'
    );

    expect(chunkDrift(table, [batch({ status: 'interrupted' })], [m], rows)[0]?.detail).toContain(
      'status interrupted'
    );

    const all = chunkDrift(
      table,
      [batch({ failed_chunks: 1, completed_at: null, status: 'partial' })],
      [m],
      rows
    );

    expect(all).toHaveLength(1);
    expect(all[0]?.detail).toMatch(/failed_chunks 1, completed_at null, status partial/);
  });

  it('not_loaded: a manifest without a ledger row, naming a flagged export', () => {
    const plain = resolved();

    const flagged = resolved({
      runId: `${batchId}-audit_log-full-collection-rest`,
      manifest: { counts_match: false, source_count: 7, exported_count: 5 },
    });

    const drifts = chunkDrift(table, [batch()], [plain, flagged], []);

    expect(drifts).toEqual([
      {
        table,
        kind: 'not_loaded',
        chunk: plain.runId,
        expected: 100,
        actual: 0,
        detail: 'no ledger row for this chunk',
      },
      {
        table,
        kind: 'not_loaded',
        chunk: flagged.runId,
        expected: 5,
        actual: 0,
        detail: expect.stringContaining(
          'counts did not match at export; load needs --allow-mismatch'
        ),
      },
    ]);
  });

  it('load_incomplete: a row not yet loaded, with progress and last error, no line_count', () => {
    const m = resolved();

    const loading = chunkDrift(
      table,
      [batch()],
      [m],
      [ledgerRow({ status: 'loading', lines_done: 40, rows_inserted: 40 })]
    );

    expect(loading).toEqual([
      {
        table,
        kind: 'load_incomplete',
        chunk: m.runId,
        expected: 100,
        actual: 40,
        detail: 'status loading, 40 of 100 lines applied',
      },
    ]);

    const failed = chunkDrift(
      table,
      [batch()],
      [m],
      [
        ledgerRow({
          status: 'failed',
          lines_done: 0,
          rows_inserted: 0,
          error: 'mysql: lost connection',
        }),
      ]
    );

    expect(kinds(failed)).toEqual(['load_incomplete']);

    expect(failed[0]?.detail).toBe(
      'status failed, 0 of 100 lines applied; last error: mysql: lost connection'
    );
  });

  it('manifest_changed: the ledger pinned another manifest body, or the object is gone', () => {
    const m = resolved({ sha256: 'c'.repeat(64) });
    const changed = chunkDrift(table, [batch()], [m], [ledgerRow()]);

    expect(changed).toEqual([
      {
        table,
        kind: 'manifest_changed',
        chunk: m.runId,
        expected: null,
        actual: null,
        detail: expect.stringMatching(
          /aaaaaaaaaaaa differs from the manifest object's cccccccccccc now/
        ),
      },
    ]);

    // A changed manifest on a still-loading row reports both facts.
    expect(
      kinds(chunkDrift(table, [batch()], [m], [ledgerRow({ status: 'loading', lines_done: 1 })]))
    ).toEqual(['manifest_changed', 'load_incomplete']);

    const gone = chunkDrift(table, [batch()], [], [ledgerRow({ id: 9 })]);

    expect(gone).toEqual([
      {
        table,
        kind: 'manifest_changed',
        chunk: ledgerRow().chunk_run_id,
        expected: 100,
        actual: null,
        detail: expect.stringMatching(
          new RegExp(
            'ledger row 9 \\(loaded\\) has no manifest object at ' +
              'mongo-archive\\/manifests\\/x\\/run_id=r\\.json any more'
          )
        ),
      },
    ]);
  });

  it('line_count: counters that do not add up to exported_count, or lines_done short of it', () => {
    const m = resolved();

    const counters = chunkDrift(
      table,
      [batch()],
      [m],
      [ledgerRow({ rows_inserted: 90, rows_updated: 5, duplicates_skipped: 1, rows_rejected: 2 })]
    );

    expect(counters).toEqual([
      {
        table,
        kind: 'line_count',
        chunk: m.runId,
        expected: 100,
        actual: 98,
        detail:
          'inserted 90 + updated 5 + duplicates 1 + rejected 2 = 98, lines_done ' +
          '100, exported_count 100',
      },
    ]);

    const lines = chunkDrift(table, [batch()], [m], [ledgerRow({ lines_done: 99 })]);

    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'line_count',
        expected: 100,
        actual: 100,
        detail: expect.stringContaining('lines_done 99'),
      }),
    ]);

    // Updates, duplicates and rejects all count as applied lines.
    expect(
      chunkDrift(
        table,
        [batch()],
        [m],
        [
          ledgerRow({
            rows_inserted: 50,
            rows_updated: 30,
            duplicates_skipped: 10,
            rows_rejected: 10,
          }),
        ]
      )
    ).toEqual([]);
  });

  it('matches rows by chunk run id across batches, in order: batches, manifests, orphans', () => {
    const delta = 'app-archive-delta-20261020T010000Z';
    const m1 = resolved();
    const m2 = resolved({ batchId: delta, runId: `${delta}-audit_log-full-collection-rest` });

    const rows = [
      ledgerRow({ id: 1 }),
      ledgerRow({
        id: 2,
        batch_id: delta,
        chunk_run_id: m2.runId,
        status: 'loading',
        lines_done: 0,
        rows_inserted: 0,
      }),
      ledgerRow({
        id: 3,
        chunk_run_id: `${batchId}-audit_log-manifest-only-full`,
        exported_count: 0,
        lines_done: 0,
        rows_inserted: 0,
      }),
    ];

    const drifts = chunkDrift(
      table,
      [batch(), batch({ run_id: delta, completed_at: null })],
      [m1, m2],
      rows
    );

    expect(drifts.map(d => [d.kind, d.chunk])).toEqual([
      ['batch_incomplete', null],
      ['load_incomplete', m2.runId],
      ['manifest_changed', `${batchId}-audit_log-manifest-only-full`],
    ]);
  });
});
