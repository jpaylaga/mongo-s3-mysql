import { describe, expect, it } from 'vitest';
import dryRunResult from '../../../src/load/dryRunResult.js';
import type { ChunkOutcome, LoadSelection } from '../../../src/types.js';
import { resolved } from './fixtures.js';

describe('dryRunResult', () => {
  it('lists every decision in batch order, the DDL it would run, the totals per table, and writes nothing', () => {
    const a = resolved({ runId: 'b1-audit_log-full-collection-full', manifest: { exported_count: 10 } });
    const b = resolved({ runId: 'b1-audit_log-full-collection-rest', manifest: { exported_count: 5 } });
    const c = resolved({ runId: 'b2-audit_log-full-collection-full', manifest: { exported_count: 7 } });
    const selections: LoadSelection[] = [
      { batch: { id: 'b1', cutoff: '2026-10-13T01:00:00Z' }, candidates: [{ resolved: a, reload: false }, { resolved: b, reload: true }], skipped: [{ resolved: c, reason: 'unverified', severity: 'incomplete' }] },
      { batch: { id: 'b2', cutoff: null }, candidates: [{ resolved: c, reload: false }], skipped: [] },
    ];
    const skippedOutcomes: ChunkOutcome[] = [{ chunk: c.runId, collection: 'audit_log', status: 'skipped', note: 'unverified' }];
    const byTable = new Map([['audit_log_entries', new Set([a.runId, b.runId, c.runId])], ['other', new Set<string>()]]);
    const messages: string[] = [];
    const result = dryRunResult((m) => messages.push(m), 'load-x', selections, ['CREATE TABLE IF NOT EXISTS `t` (\n  `id` BIGINT\n)'], byTable, skippedOutcomes);
    expect(messages).toEqual([
      `load    ${a.runId}`,
      `load    ${b.runId} (reload)`,
      `skip    ${c.runId}: unverified`,
      'batch b1: 2 chunks to load, 1 skipped',
      `load    ${c.runId}`,
      'batch b2: 1 chunks to load, 0 skipped',
      'would run: CREATE TABLE IF NOT EXISTS `t` ( ...',
      'dry run: ~22 documents from 3 chunks into audit_log_entries, other; nothing written',
    ]);
    expect(result).toEqual({
      loadRunId: 'load-x', outcomes: skippedOutcomes, exitCode: 0,
      perTable: [{ table: 'audit_log_entries', chunks: 3, inserted: 0, updated: 0, duplicates: 0, rejected: 0 }, { table: 'other', chunks: 0, inserted: 0, updated: 0, duplicates: 0, rejected: 0 }],
    });
    expect(dryRunResult(() => undefined, 'load-y', [], [], new Map(), []).perTable).toEqual([]);
  });
});
