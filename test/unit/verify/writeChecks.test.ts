import { describe, expect, it } from 'vitest';
import writeChecks from '../../../src/verify/writeChecks.js';
import type { ChunkCheck } from '../../../src/types.js';
import { memoryContext } from '../../helpers.js';

describe('writeChecks', () => {
  it('writes parse-check.json for every check and counts.json only when the check carries one', async () => {
    const { store, layout } = memoryContext({ command: 'verify' });
    const parseCheck: ChunkCheck['parseCheck'] = { run_id: 'r1', collection: 'c', mode: 'full-collection', gzip_test: null, first_line_parseable: null, first_line_has_id: null, manifest_only: false };
    const withCounts: ChunkCheck = { runId: 'r1', batchId: 'b', collection: 'c', ok: true, lines: 1, errors: [], parseCheck,
      counts: { run_id: 'r1', collection: 'c', mode: 'full-collection', count_source: 'countDocuments', source_count: 1, exported_count: 1, matches: true } };
    const recordOnly: ChunkCheck = { runId: 'r2', batchId: 'b', collection: 'c', ok: false, lines: 0, errors: ['record: x'], parseCheck: { ...parseCheck, run_id: 'r2' } };
    await writeChecks(store, layout, [withCounts, recordOnly]);
    expect([...store.objects.keys()].sort()).toEqual([layout.counts('c', 'r1'), layout.parseCheck('c', 'r1'), layout.parseCheck('c', 'r2')].sort());
    expect(JSON.parse(await store.getText(layout.counts('c', 'r1')) as string)).toMatchObject({ source_count: 1 });
    expect(await store.getText(layout.parseCheck('c', 'r2'))).toMatch(/"run_id": "r2"/);
  });
});
